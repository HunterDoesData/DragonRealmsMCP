import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserBridge, type AssistantRespondRequest, type AssistantRespondResult } from "./browserBridge.js";
import { getElanthipediaPage, getGuildSkills, getSkill, searchElanthipedia } from "./elanthipedia.js";
import { queryPgvector } from "./rag/pgvectorSearch.js";

const SERVER_NAME = "dragonrealms-mcp";
const SERVER_VERSION = "0.1.0";

const bridgePort = Number(process.env.DR_BRIDGE_PORT ?? "3989");
const bridgeToken = process.env.DR_BRIDGE_TOKEN;
const ragMinSimilarity = Math.max(
  0,
  Math.min(1, Number(process.env.RAG_MIN_SIMILARITY ?? "0.58"))
);

const aiProvider = (process.env.AI_LLM_PROVIDER ?? "openai").trim().toLowerCase();
const aiModelFromEnv = (process.env.AI_LLM_MODEL ?? "").trim();
const aiOllamaBaseUrl = (process.env.AI_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const openAiApiKey = (process.env.OPENAI_API_KEY ?? process.env.OPENAIKEY ?? "").trim();
const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();

const aiModel =
  aiModelFromEnv ||
  (aiProvider === "anthropic"
    ? "claude-3-5-haiku-latest"
    : aiProvider === "ollama"
      ? "deepseek-r1:8b"
      : "gpt-4o-mini");

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseCommandLines(answer: string): { answer: string; commands: string[] } {
  const lines = answer.split(/\r?\n/);
  const commands: string[] = [];
  const narrative: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.toUpperCase().startsWith("CMD:")) {
      const command = line.slice(4).trim();
      if (command) {
        commands.push(command);
      }
      continue;
    }
    narrative.push(raw);
  }
  return {
    answer: narrative.join("\n").trim(),
    commands
  };
}

async function providerChat(messages: ChatMessage[]): Promise<string> {
  if (aiProvider === "anthropic") {
    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for anthropic provider.");
    }
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const bodyMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: aiModel,
        max_tokens: 700,
        system,
        messages: bodyMessages
      })
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    return (payload.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("")
      .trim();
  }

  if (aiProvider === "ollama") {
    const response = await fetch(`${aiOllamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: aiModel,
        stream: false,
        messages
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    return (payload.message?.content ?? "").trim();
  }

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY/OPENAIKEY is required for openai provider.");
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: aiModel,
      temperature: 0.3,
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (payload.choices?.[0]?.message?.content ?? "").trim();
}

async function respondWithAssistant(input: AssistantRespondRequest): Promise<AssistantRespondResult> {
  const prompt = input.prompt.trim();
  const context = (input.context ?? "").trim();
  const systemPrompt = (input.systemPrompt ?? "").trim();

  const plannerSystem =
    "You are a routing planner. Return strict JSON only: {\"useRag\":boolean,\"ragQuery\":string}. " +
    "Set useRag true when DragonRealms factual/wiki info would help. No markdown.";
  const plannerUser = `Player prompt:\n${prompt}\n\nRecent context:\n${context || "(none)"}`;

  let useRag = /\b(elanthipedia|wiki|skill|spell|guild|train|training|where|location|hunt|craft)\b/i.test(prompt);
  let ragQuery = prompt;

  try {
    const plannerText = await providerChat([
      { role: "system", content: plannerSystem },
      { role: "user", content: plannerUser }
    ]);
    const planner = extractJsonObject(plannerText);
    if (planner) {
      const plannerUseRag = planner.useRag;
      const plannerQuery = planner.ragQuery;
      if (typeof plannerUseRag === "boolean") {
        useRag = plannerUseRag;
      }
      if (typeof plannerQuery === "string" && plannerQuery.trim().length >= 2) {
        ragQuery = plannerQuery.trim();
      }
    }
  } catch {
    // keep heuristic defaults when planner call fails
  }

  let ragBlock = "";
  let ragUsed = false;
  if (useRag) {
    const ragResults = await queryPgvector(ragQuery, 6, { hybrid: true });
    const confident = ragResults.filter((item) => item.similarity >= ragMinSimilarity).slice(0, 4);
    if (confident.length > 0) {
      ragUsed = true;
      ragBlock = confident
        .map((item, index) => {
          const citation = `${item.title}${item.headingPath ? ` :: ${item.headingPath}` : ""}`;
          const snippet = item.text.replace(/\s+/g, " ").trim();
          const trimmed = snippet.length > 480 ? `${snippet.slice(0, 480)}...` : snippet;
          return `${index + 1}. ${citation} (${item.url})\nSimilarity: ${item.similarity.toFixed(4)}\n${trimmed}`;
        })
        .join("\n\n");
    }
  }

  const finalSystem = [
    systemPrompt || "You are a DragonRealms gameplay coach.",
    "If useful, provide one actionable command line prefixed exactly as 'CMD: '.",
    "Stay concise and practical for live gameplay."
  ]
    .filter(Boolean)
    .join("\n\n");

  const finalUser = [
    `Player request:\n${prompt}`,
    `Recent game context:\n${context || "(none)"}`,
    ragUsed ? `Tool result elanthipedia_rag_query:\n${ragBlock}` : "Tool result elanthipedia_rag_query: (not used)"
  ].join("\n\n");

  const modelReply = await providerChat([
    { role: "system", content: finalSystem },
    { role: "user", content: finalUser }
  ]);

  const parsed = parseCommandLines(modelReply);
  return {
    answer: parsed.answer || "(No narrative response.)",
    proposedCommands: parsed.commands,
    provider: aiProvider,
    model: aiModel,
    ragUsed
  };
}

const bridge = new BrowserBridge({
  token: bridgeToken,
  assistantResponder: respondWithAssistant
});

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

server.tool(
  "elanthipedia_rag_query",
  "Search local pgvector-backed Elanthipedia chunks and return cited context snippets.",
  {
    query: z.string().min(2),
    topK: z.number().int().min(1).max(25).optional(),
    hybrid: z.boolean().optional(),
    maxCharsPerResult: z.number().int().min(150).max(1500).optional()
  },
  async ({ query, topK, hybrid, maxCharsPerResult }) => {
    const results = await queryPgvector(query, topK ?? 8, { hybrid: hybrid ?? true });
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No local RAG matches found. Ensure pgvector is populated." }]
      };
    }

    const confidentResults = results.filter((item) => item.similarity >= ragMinSimilarity);
    if (confidentResults.length === 0) {
      const best = results[0];
      return {
        content: [
          {
            type: "text",
            text: [
              `Query: ${query}`,
              `Mode: ${(hybrid ?? true) ? "hybrid" : "semantic-only"}`,
              "Status: insufficient evidence from local RAG index.",
              `Best similarity: ${best.similarity.toFixed(4)} (threshold ${ragMinSimilarity.toFixed(2)}).`,
              "Try a narrower query or reduce RAG_MIN_SIMILARITY if needed."
            ].join("\n")
          }
        ]
      };
    }

    const clip = maxCharsPerResult ?? 500;
    const body = confidentResults
      .map((item, index) => {
        const snippet = item.text.replace(/\s+/g, " ").trim();
        const trimmed = snippet.length > clip ? `${snippet.slice(0, clip)}...` : snippet;
        const citation = `${item.title}${item.headingPath ? ` :: ${item.headingPath}` : ""}`;
        return [
          `${index + 1}. ${citation}`,
          `Citation: ${citation} (${item.url})`,
          `Similarity: ${item.similarity.toFixed(4)}`,
          `Snippet: ${trimmed}`
        ].join("\n");
      })
      .join("\n\n");

    const text = `Query: ${query}\nMode: ${(hybrid ?? true) ? "hybrid" : "semantic-only"}\nThreshold: >= ${ragMinSimilarity.toFixed(2)}\n\n${body}`;

    return {
      content: [{ type: "text", text }]
    };
  }
);

server.tool(
  "elanthipedia_search",
  "Search Elanthipedia for DragonRealms topics.",
  {
    query: z.string().min(2),
    limit: z.number().int().min(1).max(10).optional()
  },
  async ({ query, limit }) => {
    const results = await searchElanthipedia(query, limit ?? 5);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No Elanthipedia results found." }]
      };
    }

    const text = results
      .map((result, index) => `${index + 1}. ${result.title}\n${result.description}\n${result.url}`)
      .join("\n\n");

    return {
      content: [{ type: "text", text }]
    };
  }
);

server.tool(
  "elanthipedia_page",
  "Fetch and clean a specific Elanthipedia page by title or URL.",
  {
    titleOrUrl: z.string().min(2),
    maxChars: z.number().int().min(500).max(25000).optional()
  },
  async ({ titleOrUrl, maxChars }) => {
    const page = await getElanthipediaPage(titleOrUrl);
    const max = maxChars ?? 8000;
    const trimmed = page.text.length > max ? `${page.text.slice(0, max)}...` : page.text;

    return {
      content: [
        {
          type: "text",
          text: `Title: ${page.title}\nURL: ${page.url}\n\n${trimmed}`
        }
      ]
    };
  }
);

server.tool(
  "get_skill",
  "Fetch a DragonRealms skill page and return cleaned skill knowledge.",
  {
    skill: z.string().min(1),
    maxChars: z.number().int().min(500).max(25000).optional()
  },
  async ({ skill, maxChars }) => {
    const page = await getSkill(skill);
    const max = maxChars ?? 8000;
    const trimmed = page.text.length > max ? `${page.text.slice(0, max)}...` : page.text;

    return {
      content: [
        {
          type: "text",
          text: `Skill: ${page.title}\nURL: ${page.url}\n\n${trimmed}`
        }
      ]
    };
  }
);

server.tool(
  "get_guild_skills",
  "Get guild-specific skills for a DragonRealms guild.",
  {
    guild: z.string().min(2)
  },
  async ({ guild }) => {
    const skills = await getGuildSkills(guild);
    if (skills.length === 0) {
      return {
        content: [{ type: "text", text: `No guild-specific skills found for '${guild}'.` }]
      };
    }

    const text = skills
      .map(
        (skill, index) =>
          `${index + 1}. ${skill.skill} (${skill.guild})\nSkillset: ${skill.skillset || "n/a"}\nTraining: ${skill.training || "n/a"}\nBonus: ${skill.bonus || "n/a"}\n${skill.url}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text }]
    };
  }
);

server.tool(
  "dr_send_command",
  "Queue a DragonRealms command for the browser bridge client.",
  {
    command: z.string().min(1)
  },
  async ({ command }) => {
    const queued = bridge.enqueueCommand(command.trim());
    return {
      content: [
        {
          type: "text",
          text: `Queued command #${queued.id} at ${queued.timestamp}: ${queued.command}`
        }
      ]
    };
  }
);

server.tool(
  "dr_propose_command",
  "Create a proposed command that must be approved in the UI before execution.",
  {
    command: z.string().min(1),
    reason: z.string().optional()
  },
  async ({ command, reason }) => {
    const proposal = bridge.proposeCommand(command.trim(), reason?.trim() ?? "");
    return {
      content: [
        {
          type: "text",
          text: `Proposed command #${proposal.id}: ${proposal.command}${
            proposal.reason ? `\nReason: ${proposal.reason}` : ""
          }\nStatus: ${proposal.status}`
        }
      ]
    };
  }
);

server.tool(
  "dr_get_proposals",
  "Get proposed DragonRealms commands and their approval status.",
  {
    status: z.enum(["pending", "approved", "rejected"]).optional(),
    limit: z.number().int().min(1).max(200).optional()
  },
  async ({ status, limit }) => {
    const proposals = bridge.listProposals(status).slice(-(limit ?? 50));
    if (proposals.length === 0) {
      return {
        content: [{ type: "text", text: "No proposals found." }]
      };
    }

    const text = proposals
      .map(
        (proposal) =>
          `[#${proposal.id}] ${proposal.status.toUpperCase()} ${proposal.command}\nCreated: ${proposal.timestamp}${
            proposal.reason ? `\nReason: ${proposal.reason}` : ""
          }${proposal.reviewedAt ? `\nReviewed: ${proposal.reviewedAt}` : ""}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text }]
    };
  }
);

server.tool(
  "dr_get_output",
  "Get recent game output lines captured by the browser bridge.",
  {
    limit: z.number().int().min(1).max(500).optional(),
    contains: z.string().optional()
  },
  async ({ limit, contains }) => {
    const output = bridge.getOutput(limit ?? 50, contains);
    if (output.length === 0) {
      return {
        content: [{ type: "text", text: "No output captured yet." }]
      };
    }

    const text = output
      .map((line) => `[${line.id}] ${line.timestamp} (${line.source}) ${line.text}`)
      .join("\n");

    return {
      content: [{ type: "text", text }]
    };
  }
);

server.tool(
  "dr_clear_output",
  "Clear buffered game output from the local bridge.",
  {},
  async () => {
    const removed = bridge.clearOutput();
    return {
      content: [{ type: "text", text: `Cleared ${removed} buffered output entries.` }]
    };
  }
);

server.tool(
  "dr_bridge_status",
  "Show browser bridge status and connection details.",
  {},
  async () => {
    const status = bridge.getStatus(bridgePort);
    return {
      content: [
        {
          type: "text",
          text: [
            `Bridge URL: ${status.bridgeUrl}`,
            `Queued Commands: ${status.queuedCommands}`,
            `Buffered Output: ${status.bufferedOutput}`,
            `Pending Proposals: ${status.pendingProposals}`,
            `Token Required: ${status.tokenRequired ? "yes" : "no"}`,
            `Pull commands: GET ${status.bridgeUrl}/io/commands`,
            `Push output: POST ${status.bridgeUrl}/io/output { text, source }`,
            `Proposal queue: GET ${status.bridgeUrl}/agent/proposals?status=pending`
          ].join("\n")
        }
      ]
    };
  }
);

async function main(): Promise<void> {
  await bridge.start(bridgePort);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
