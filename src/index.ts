import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserBridge } from "./browserBridge.js";
import { getElanthipediaPage, getGuildSkills, getSkill, searchElanthipedia } from "./elanthipedia.js";

const SERVER_NAME = "dragonrealms-mcp";
const SERVER_VERSION = "0.1.0";

const bridgePort = Number(process.env.DR_BRIDGE_PORT ?? "3989");
const bridgeToken = process.env.DR_BRIDGE_TOKEN;
const bridge = new BrowserBridge({ token: bridgeToken });

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

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
