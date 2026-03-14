import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3989";
function authHeaders(token) {
    const headers = { "Content-Type": "application/json" };
    if (token.trim()) {
        headers["x-dr-token"] = token.trim();
    }
    return headers;
}
export function App() {
    const [bridgeUrl, setBridgeUrl] = useState(localStorage.getItem("dr.bridgeUrl") || DEFAULT_BRIDGE_URL);
    const [token, setToken] = useState(localStorage.getItem("dr.bridgeToken") || "");
    const [health, setHealth] = useState(null);
    const [output, setOutput] = useState([]);
    const [proposals, setProposals] = useState([]);
    const [pendingCommands, setPendingCommands] = useState([]);
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
    async function refreshAll() {
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
        const healthData = (await healthResp.json());
        const outputData = (await outputResp.json());
        const proposalsData = (await proposalsResp.json());
        const pendingData = (await pendingResp.json());
        setHealth(healthData);
        setOutput(outputData.output ?? []);
        setProposals(proposalsData.proposals ?? []);
        setPendingCommands(pendingData.commands ?? []);
        setStatusMessage(`Updated ${new Date().toLocaleTimeString()}`);
    }
    useEffect(() => {
        refreshAll().catch((error) => {
            setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
        });
    }, []);
    useEffect(() => {
        if (!autoRefresh) {
            return;
        }
        const handle = window.setInterval(() => {
            refreshAll().catch((error) => {
                setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
            });
        }, 2000);
        return () => window.clearInterval(handle);
    }, [autoRefresh, bridgeUrl, token]);
    async function reviewProposal(id, action) {
        const response = await fetch(`${bridgeUrl}/agent/proposals/${id}/${action}`, {
            method: "POST",
            headers: authHeaders(token)
        });
        if (!response.ok) {
            const payload = (await response.json().catch(() => ({})));
            throw new Error(payload.error ?? `${action} failed.`);
        }
    }
    async function enqueueManualCommand() {
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
            const payload = (await response.json().catch(() => ({})));
            throw new Error(payload.error ?? "Queue command failed.");
        }
        setManualCommand("");
    }
    async function clearOutput() {
        const response = await fetch(`${bridgeUrl}/io/output`, {
            method: "DELETE",
            headers: authHeaders(token)
        });
        if (!response.ok) {
            const payload = (await response.json().catch(() => ({})));
            throw new Error(payload.error ?? "Clear output failed.");
        }
    }
    return (_jsxs("main", { children: [_jsxs("header", { children: [_jsx("h1", { children: "DragonRealms Agent Control Panel" }), _jsx("p", { children: "Telemetry + approval queue for local bridge" })] }), _jsxs("section", { className: "card settings", children: [_jsxs("label", { children: ["Bridge URL", _jsx("input", { value: bridgeUrl, onChange: (event) => setBridgeUrl(event.target.value) })] }), _jsxs("label", { children: ["Token (optional)", _jsx("input", { type: "password", value: token, onChange: (event) => setToken(event.target.value) })] }), _jsxs("div", { className: "actions", children: [_jsx("button", { onClick: () => {
                                    refreshAll().catch((error) => {
                                        setStatusMessage(error instanceof Error ? error.message : "Refresh failed.");
                                    });
                                }, children: "Refresh Now" }), _jsx("button", { onClick: () => setAutoRefresh((value) => !value), children: autoRefresh ? "Pause Auto" : "Auto Refresh" }), _jsx("span", { className: "status", children: statusMessage })] })] }), _jsxs("section", { className: "grid", children: [_jsxs("article", { className: "card", children: [_jsx("h2", { children: "Bridge Health" }), _jsxs("ul", { children: [_jsxs("li", { children: ["Queued Commands: ", health?.queuedCommands ?? "-"] }), _jsxs("li", { children: ["Buffered Output: ", health?.bufferedOutput ?? "-"] }), _jsxs("li", { children: ["Pending Proposals: ", health?.pendingProposals ?? "-"] })] })] }), _jsxs("article", { className: "card", children: [_jsx("h2", { children: "Manual Command" }), _jsxs("div", { className: "row", children: [_jsx("input", { placeholder: "e.g. look", value: manualCommand, onChange: (event) => setManualCommand(event.target.value) }), _jsx("button", { onClick: () => {
                                            enqueueManualCommand()
                                                .then(refreshAll)
                                                .catch((error) => {
                                                setStatusMessage(error instanceof Error ? error.message : "Queue failed.");
                                            });
                                        }, children: "Queue" })] }), _jsx("p", { className: "muted", children: "Use this to push immediate commands directly to the game queue." })] }), _jsxs("article", { className: "card wide", children: [_jsx("h2", { children: "Pending Agent Proposals" }), proposals.length === 0 ? (_jsx("p", { className: "muted", children: "No pending proposals." })) : (_jsx("ul", { className: "proposal-list", children: proposals.map((proposal) => (_jsxs("li", { children: [_jsxs("div", { children: [_jsxs("strong", { children: ["#", proposal.id] }), " ", proposal.command, proposal.reason ? _jsxs("p", { className: "muted", children: ["Reason: ", proposal.reason] }) : null] }), _jsxs("div", { className: "actions", children: [_jsx("button", { onClick: () => {
                                                        reviewProposal(proposal.id, "approve")
                                                            .then(refreshAll)
                                                            .catch((error) => {
                                                            setStatusMessage(error instanceof Error ? error.message : "Approve failed.");
                                                        });
                                                    }, children: "Approve" }), _jsx("button", { className: "danger", onClick: () => {
                                                        reviewProposal(proposal.id, "reject")
                                                            .then(refreshAll)
                                                            .catch((error) => {
                                                            setStatusMessage(error instanceof Error ? error.message : "Reject failed.");
                                                        });
                                                    }, children: "Reject" })] })] }, proposal.id))) }))] }), _jsxs("article", { className: "card wide", children: [_jsx("h2", { children: "Queued Commands" }), pendingCommands.length === 0 ? (_jsx("p", { className: "muted", children: "No queued commands waiting for the userscript poll." })) : (_jsx("ul", { className: "mono-list", children: pendingCommands.map((command) => (_jsxs("li", { children: ["[", command.id, "] ", command.command] }, command.id))) }))] }), _jsxs("article", { className: "card wide", children: [_jsxs("div", { className: "title-row", children: [_jsx("h2", { children: "Recent Game Output" }), _jsx("button", { className: "danger", onClick: () => {
                                            clearOutput()
                                                .then(refreshAll)
                                                .catch((error) => {
                                                setStatusMessage(error instanceof Error ? error.message : "Clear failed.");
                                            });
                                        }, children: "Clear" })] }), sortedOutput.length === 0 ? (_jsx("p", { className: "muted", children: "No output lines captured yet." })) : (_jsx("ul", { className: "mono-list output-list", children: sortedOutput.map((line) => (_jsxs("li", { children: ["[", line.id, "] ", line.text] }, line.id))) }))] })] })] }));
}
