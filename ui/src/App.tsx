import { useEffect, useMemo, useState } from "react";

type HealthResponse = {
  ok: boolean;
  queuedCommands: number;
  bufferedOutput: number;
  pendingProposals: number;
};

type OutputEntry = {
  id: number;
  text: string;
  source: string;
  timestamp: string;
};

type Proposal = {
  id: number;
  command: string;
  reason: string;
  timestamp: string;
  status: "pending" | "approved" | "rejected";
  reviewedAt?: string;
};

type CommandEntry = {
  id: number;
  command: string;
  timestamp: string;
};

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3989";

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token.trim()) {
    headers["x-dr-token"] = token.trim();
  }
  return headers;
}

export function App() {
  const [bridgeUrl, setBridgeUrl] = useState(localStorage.getItem("dr.bridgeUrl") || DEFAULT_BRIDGE_URL);
  const [token, setToken] = useState(localStorage.getItem("dr.bridgeToken") || "");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [pendingCommands, setPendingCommands] = useState<CommandEntry[]>([]);
  const [manualCommand, setManualCommand] = useState("");
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const sortedOutput = useMemo(() => [...output].reverse(), [output]);

  useEffect(() => {
    localStorage.setItem("dr.bridgeUrl", bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    localStorage.setItem("dr.bridgeToken", token);
  }, [token]);

  async function refreshAll(): Promise<void> {
    const headers = authHeaders(token);

    const [healthResp, outputResp, proposalsResp, pendingResp] = await Promise.all([
      fetch(`${bridgeUrl}/health`),
      fetch(`${bridgeUrl}/io/output?limit=200`, { headers }),
      fetch(`${bridgeUrl}/agent/proposals?status=pending`, { headers }),
      fetch(`${bridgeUrl}/io/commands/pending`, { headers })
    ]);

    if (!healthResp.ok) {
      throw new Error(`Health request failed (${healthResp.status}).`);
    }
    if (!outputResp.ok || !proposalsResp.ok || !pendingResp.ok) {
      throw new Error("One or more bridge requests failed. Check token and bridge URL.");
    }

    const healthData = (await healthResp.json()) as HealthResponse;
    const outputData = (await outputResp.json()) as { output: OutputEntry[] };
    const proposalsData = (await proposalsResp.json()) as { proposals: Proposal[] };
    const pendingData = (await pendingResp.json()) as { commands: CommandEntry[] };

    setHealth(healthData);
    setOutput(outputData.output ?? []);
    setProposals(proposalsData.proposals ?? []);
    setPendingCommands(pendingData.commands ?? []);
    setStatusMessage(`Updated ${new Date().toLocaleTimeString()}`);
  }

  useEffect(() => {
    refreshAll().catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
    });
  }, []);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    const handle = window.setInterval(() => {
      refreshAll().catch((error: unknown) => {
        setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
      });
    }, 2000);

    return () => window.clearInterval(handle);
  }, [autoRefresh, bridgeUrl, token]);

  async function reviewProposal(id: number, action: "approve" | "reject"): Promise<void> {
    const response = await fetch(`${bridgeUrl}/agent/proposals/${id}/${action}`, {
      method: "POST",
      headers: authHeaders(token)
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? `${action} failed.`);
    }
  }

  async function enqueueManualCommand(): Promise<void> {
    const command = manualCommand.trim();
    if (!command) {
      setStatusMessage("Enter a command first.");
      return;
    }

    const response = await fetch(`${bridgeUrl}/io/commands`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ command })
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? "Queue command failed.");
    }

    setManualCommand("");
  }

  async function clearOutput(): Promise<void> {
    const response = await fetch(`${bridgeUrl}/io/output`, {
      method: "DELETE",
      headers: authHeaders(token)
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? "Clear output failed.");
    }
  }

  return (
    <main>
      <header>
        <h1>DragonRealms Agent Control Panel</h1>
        <p>Telemetry + approval queue for local bridge</p>
      </header>

      <section className="card settings">
        <label>
          Bridge URL
          <input value={bridgeUrl} onChange={(event) => setBridgeUrl(event.target.value)} />
        </label>
        <label>
          Token (optional)
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <div className="actions">
          <button
            onClick={() => {
              refreshAll().catch((error: unknown) => {
                setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
              });
            }}
          >
            Refresh Now
          </button>
          <button onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "Pause Auto" : "Auto Refresh"}</button>
          <span className="status">{statusMessage}</span>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Bridge Health</h2>
          <ul>
            <li>Queued Commands: {health?.queuedCommands ?? "-"}</li>
            <li>Buffered Output: {health?.bufferedOutput ?? "-"}</li>
            <li>Pending Proposals: {health?.pendingProposals ?? "-"}</li>
          </ul>
        </article>

        <article className="card">
          <h2>Manual Command</h2>
          <div className="row">
            <input
              placeholder="e.g. look"
              value={manualCommand}
              onChange={(event) => setManualCommand(event.target.value)}
            />
            <button
              onClick={() => {
                enqueueManualCommand()
                  .then(refreshAll)
                  .catch((error: unknown) => {
                    setStatusMessage(error instanceof Error ? error.message : "Queue failed.");
                  });
              }}
            >
              Queue
            </button>
          </div>
          <p className="muted">Use this to push immediate commands directly to the game queue.</p>
        </article>

        <article className="card wide">
          <h2>Pending Agent Proposals</h2>
          {proposals.length === 0 ? (
            <p className="muted">No pending proposals.</p>
          ) : (
            <ul className="proposal-list">
              {proposals.map((proposal) => (
                <li key={proposal.id}>
                  <div>
                    <strong>#{proposal.id}</strong> {proposal.command}
                    {proposal.reason ? <p className="muted">Reason: {proposal.reason}</p> : null}
                  </div>
                  <div className="actions">
                    <button
                      onClick={() => {
                        reviewProposal(proposal.id, "approve")
                          .then(refreshAll)
                          .catch((error: unknown) => {
                            setStatusMessage(error instanceof Error ? error.message : "Approve failed.");
                          });
                      }}
                    >
                      Approve
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        reviewProposal(proposal.id, "reject")
                          .then(refreshAll)
                          .catch((error: unknown) => {
                            setStatusMessage(error instanceof Error ? error.message : "Reject failed.");
                          });
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="card wide">
          <h2>Queued Commands</h2>
          {pendingCommands.length === 0 ? (
            <p className="muted">No queued commands waiting for the userscript poll.</p>
          ) : (
            <ul className="mono-list">
              {pendingCommands.map((command) => (
                <li key={command.id}>[{command.id}] {command.command}</li>
              ))}
            </ul>
          )}
        </article>

        <article className="card wide">
          <div className="title-row">
            <h2>Recent Game Output</h2>
            <button
              className="danger"
              onClick={() => {
                clearOutput()
                  .then(refreshAll)
                  .catch((error: unknown) => {
                    setStatusMessage(error instanceof Error ? error.message : "Clear failed.");
                  });
              }}
            >
              Clear
            </button>
          </div>
          {sortedOutput.length === 0 ? (
            <p className="muted">No output lines captured yet.</p>
          ) : (
            <ul className="mono-list output-list">
              {sortedOutput.map((line) => (
                <li key={line.id}>[{line.id}] {line.text}</li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </main>
  );
}
