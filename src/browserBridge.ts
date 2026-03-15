import express, { type Request } from "express";
import { createServer, type Server } from "node:http";

type OutputEntry = {
  id: number;
  text: string;
  source: string;
  timestamp: string;
};

type CommandEntry = {
  id: number;
  command: string;
  timestamp: string;
};

type ProposalStatus = "pending" | "approved" | "rejected";

type ProposalEntry = {
  id: number;
  command: string;
  reason: string;
  timestamp: string;
  status: ProposalStatus;
  reviewedAt?: string;
};

export type AssistantRespondRequest = {
  prompt: string;
  context?: string;
  systemPrompt?: string;
  source?: string;
  autonomyMode?: boolean;
  autonomySwitches?: string[];
};

export type AssistantRespondResult = {
  answer: string;
  proposedCommands?: string[];
  provider?: string;
  model?: string;
  ragUsed?: boolean;
};

function getAuthToken(req: Request): string {
  const authHeader = req.header("authorization") ?? "";
  const headerToken = req.header("x-dr-token") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return headerToken.trim();
}

export class BrowserBridge {
  private readonly app = express();
  private readonly maxOutputEntries: number;
  private readonly token?: string;
  private readonly assistantResponder?: (request: AssistantRespondRequest) => Promise<AssistantRespondResult>;
  private httpServer?: Server;

  private output: OutputEntry[] = [];
  private commands: CommandEntry[] = [];
  private proposals: ProposalEntry[] = [];
  private outputId = 1;
  private commandId = 1;
  private proposalId = 1;

  constructor(options?: {
    maxOutputEntries?: number;
    token?: string;
    assistantResponder?: (request: AssistantRespondRequest) => Promise<AssistantRespondResult>;
  }) {
    this.maxOutputEntries = options?.maxOutputEntries ?? 1000;
    this.token = options?.token;
    this.assistantResponder = options?.assistantResponder;
    this.configureRoutes();
  }

  private authorize(req: Request): boolean {
    if (!this.token) {
      return true;
    }
    return getAuthToken(req) === this.token;
  }

  private configureRoutes(): void {
    this.app.use(express.json({ limit: "256kb" }));
    this.app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-DR-Token");
      res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    this.app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        queuedCommands: this.commands.length,
        bufferedOutput: this.output.length,
        pendingProposals: this.proposals.filter((proposal) => proposal.status === "pending").length
      });
    });

    this.app.get("/io/output", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const limitRaw = req.query.limit;
      const contains = typeof req.query.contains === "string" ? req.query.contains : undefined;
      const limit = typeof limitRaw === "string" ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;

      res.json({
        ok: true,
        output: this.getOutput(limit, contains)
      });
    });

    this.app.delete("/io/output", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const cleared = this.clearOutput();
      res.json({ ok: true, cleared });
    });

    this.app.get("/io/commands/pending", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      res.json({
        ok: true,
        commands: this.commands
      });
    });

    this.app.post("/io/commands", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
      if (!command) {
        res.status(400).json({ error: "Body must contain non-empty 'command'." });
        return;
      }

      const queued = this.enqueueCommand(command);
      res.json({ ok: true, command: queued });
    });

    this.app.post("/io/output", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "browser";

      if (!text) {
        res.status(400).json({ error: "Body must contain non-empty 'text'." });
        return;
      }

      this.output.push({
        id: this.outputId++,
        text,
        source: source || "browser",
        timestamp: new Date().toISOString()
      });

      if (this.output.length > this.maxOutputEntries) {
        this.output = this.output.slice(this.output.length - this.maxOutputEntries);
      }

      res.json({ ok: true });
    });

    this.app.get("/io/commands", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === "string" ? Math.max(1, Math.min(100, Number(limitRaw) || 20)) : 20;
      const commands = this.commands.slice(0, limit);
      this.commands = this.commands.slice(commands.length);

      res.json({
        ok: true,
        commands
      });
    });

    this.app.post("/agent/proposals", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

      if (!command) {
        res.status(400).json({ error: "Body must contain non-empty 'command'." });
        return;
      }

      const proposal = this.proposeCommand(command, reason);
      res.json({ ok: true, proposal });
    });

    this.app.get("/agent/proposals", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : undefined;
      const proposals = this.listProposals(
        status === "pending" || status === "approved" || status === "rejected" ? status : undefined
      );

      res.json({ ok: true, proposals });
    });

    this.app.post("/agent/proposals/:id/approve", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const id = Number(req.params.id);
      const proposal = this.approveProposal(id);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found or already reviewed." });
        return;
      }

      res.json({ ok: true, proposal });
    });

    this.app.post("/agent/proposals/:id/reject", (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const id = Number(req.params.id);
      const proposal = this.rejectProposal(id);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found or already reviewed." });
        return;
      }

      res.json({ ok: true, proposal });
    });

    this.app.post("/agent/respond", async (req, res) => {
      if (!this.authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      if (!this.assistantResponder) {
        res.status(503).json({ error: "Assistant responder is not configured." });
        return;
      }

      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";
      const systemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.trim() : "";
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "bridge";
      const autonomyMode = req.body?.autonomyMode === true;
      const autonomySwitches = Array.isArray(req.body?.autonomySwitches)
        ? req.body.autonomySwitches.filter((item: unknown): item is string => typeof item === "string")
        : undefined;

      if (!prompt) {
        res.status(400).json({ error: "Body must contain non-empty 'prompt'." });
        return;
      }

      try {
        const response = await this.assistantResponder({
          prompt,
          context: context || undefined,
          systemPrompt: systemPrompt || undefined,
          source,
          autonomyMode,
          autonomySwitches
        });
        res.json({ ok: true, response });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: detail });
      }
    });
  }

  async start(port: number): Promise<void> {
    if (this.httpServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer(this.app);
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.httpServer = server;
        resolve();
      });
    });
  }

  enqueueCommand(command: string): CommandEntry {
    const item: CommandEntry = {
      id: this.commandId++,
      command,
      timestamp: new Date().toISOString()
    };
    this.commands.push(item);
    return item;
  }

  proposeCommand(command: string, reason = ""): ProposalEntry {
    const proposal: ProposalEntry = {
      id: this.proposalId++,
      command,
      reason,
      timestamp: new Date().toISOString(),
      status: "pending"
    };
    this.proposals.push(proposal);
    return proposal;
  }

  listProposals(status?: ProposalStatus): ProposalEntry[] {
    if (!status) {
      return this.proposals;
    }
    return this.proposals.filter((proposal) => proposal.status === status);
  }

  approveProposal(id: number): ProposalEntry | undefined {
    const proposal = this.proposals.find((entry) => entry.id === id && entry.status === "pending");
    if (!proposal) {
      return undefined;
    }

    proposal.status = "approved";
    proposal.reviewedAt = new Date().toISOString();
    this.enqueueCommand(proposal.command);
    return proposal;
  }

  rejectProposal(id: number): ProposalEntry | undefined {
    const proposal = this.proposals.find((entry) => entry.id === id && entry.status === "pending");
    if (!proposal) {
      return undefined;
    }

    proposal.status = "rejected";
    proposal.reviewedAt = new Date().toISOString();
    return proposal;
  }

  getOutput(limit = 50, contains?: string): OutputEntry[] {
    const filtered = contains
      ? this.output.filter((entry) => entry.text.toLowerCase().includes(contains.toLowerCase()))
      : this.output;

    return filtered.slice(Math.max(0, filtered.length - Math.max(1, Math.min(500, limit))));
  }

  clearOutput(): number {
    const count = this.output.length;
    this.output = [];
    return count;
  }

  getStatus(port: number): {
    port: number;
    bridgeUrl: string;
    queuedCommands: number;
    bufferedOutput: number;
    pendingProposals: number;
    tokenRequired: boolean;
  } {
    return {
      port,
      bridgeUrl: `http://127.0.0.1:${port}`,
      queuedCommands: this.commands.length,
      bufferedOutput: this.output.length,
      pendingProposals: this.proposals.filter((proposal) => proposal.status === "pending").length,
      tokenRequired: Boolean(this.token)
    };
  }
}
