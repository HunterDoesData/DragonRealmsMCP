#include "aibridgeservice.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QDateTime>
#include <QRegularExpression>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QProcessEnvironment>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>

#include "clientsettings.h"

AiBridgeService::AiBridgeService(QObject* parent)
    : QObject(parent),
      settings(ClientSettings::getInstance()),
      network(new QNetworkAccessManager(this)),
      mcpProcess(new QProcess(this)),
      pollTimer(new QTimer(this)),
      healthTimer(new QTimer(this)),
      enabled(false),
      sendOutput(true),
      consumeCommands(false),
      runInternalMcp(true),
    embeddedMode(true),
      pollIntervalMs(1200),
      healthOk(false),
      healthKnown(false),
    observerEnabled(false),
    observerRequestInFlight(false),
    lastObserverRequestMs(0),
            lastObserverEventFingerprint(""),
      baseUrl("http://127.0.0.1:8787") {
    pollTimer->setSingleShot(false);
    healthTimer->setSingleShot(false);
    connect(pollTimer, SIGNAL(timeout()), this, SLOT(pollCommands()));
    connect(healthTimer, SIGNAL(timeout()), this, SLOT(checkHealth()));

    connect(mcpProcess, static_cast<void (QProcess::*)(int, QProcess::ExitStatus)>(&QProcess::finished),
            this, [this](int, QProcess::ExitStatus) {
                if (enabled && runInternalMcp) {
                    emit statusMessage("Internal MCP server stopped.");
                }
            });
    connect(mcpProcess, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error == QProcess::FailedToStart) {
            emit statusMessage("Internal MCP server failed to start. Verify Node and MCP entry path.");
        }
    });

    this->reloadSettings();
}

bool AiBridgeService::isEnabled() const {
    return enabled;
}

QString AiBridgeService::buildCoachSystemPrompt() const {
    return QString(
        "You are a DragonRealms in-game coach. "
        "Your role is strictly limited to helping the player with DragonRealms gameplay. "
        "Use only DragonRealms context, commands, maps/navigation guidance, and Elanthipedia-style game knowledge. "
        "If asked for non-DragonRealms topics, refuse briefly and redirect to DragonRealms coaching. "
        "Always ground advice in the provided game data context. "
        "If context is missing, ask a short clarifying question. "
        "When the player asks location (e.g., 'where am I'), infer it directly from recent room/exits text when available; do not suggest 'look' if room context is already present. "
        "Prefer actionable output in this format: Situation, Recommendation, Commands, Caution. "
        "Never claim to have executed commands yourself unless explicitly told command execution is enabled. "
        "Keep responses concise and practical for live play. "
        "When appropriate, propose at most one executable command prefixed exactly as 'CMD: '."
    );
}

QString AiBridgeService::buildRecentGameContext() const {
    if (recentGameLines.isEmpty()) {
        return QString("No recent game output is available yet.");
    }

    return recentGameLines.join("\n");
}

bool AiBridgeService::isLocationQuestion(const QString& prompt) const {
    const QString p = prompt.toLower().trimmed();
    return p.contains("where am i")
        || p.contains("where are we")
        || p.contains("what room")
        || p.contains("current location")
        || p.contains("which room")
        || p.contains("where is this");
}

QString AiBridgeService::inferCurrentLocationFromContext() const {
    if (recentGameLines.isEmpty()) {
        return QString();
    }

    QString exitsLine;
    QString roomLine;
    QString explicitYouAreIn;

    for (int i = recentGameLines.size() - 1; i >= 0; --i) {
        const QString line = recentGameLines.at(i).trimmed();
        const QString lowered = line.toLower();
        if (line.isEmpty()) {
            continue;
        }

        if (explicitYouAreIn.isEmpty() && lowered.contains("you are in ")) {
            explicitYouAreIn = line;
        }

        if (exitsLine.isEmpty() && (lowered.contains("obvious exits") || lowered.contains("obvious paths"))) {
            exitsLine = line;

            for (int j = i - 1; j >= 0 && j >= i - 10; --j) {
                const QString candidate = recentGameLines.at(j).trimmed();
                const QString cLower = candidate.toLower();
                if (candidate.isEmpty()) {
                    continue;
                }

                if (cLower.startsWith("also here")
                    || cLower.startsWith("you also see")
                    || cLower.startsWith("roundtime")
                    || cLower.startsWith("[ai]")) {
                    continue;
                }

                if (candidate.length() >= 3 && candidate.length() <= 120) {
                    roomLine = candidate;
                    break;
                }
            }
        }

        if (!exitsLine.isEmpty() && !roomLine.isEmpty()) {
            break;
        }
    }

    if (!explicitYouAreIn.isEmpty()) {
        if (!exitsLine.isEmpty()) {
            return QString("%1 | %2").arg(explicitYouAreIn, exitsLine);
        }
        return explicitYouAreIn;
    }

    if (!roomLine.isEmpty() && !exitsLine.isEmpty()) {
        return QString("%1 | %2").arg(roomLine, exitsLine);
    }

    if (!roomLine.isEmpty()) {
        return roomLine;
    }

    return QString();
}

void AiBridgeService::appendGameContext(const QString& text) {
    const QStringList lines = text.split('\n', Qt::SkipEmptyParts);
    for (const QString& rawLine : lines) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) {
            continue;
        }

        recentGameLines.append(line);
    }

    const int maxContextLines = 140;
    while (recentGameLines.size() > maxContextLines) {
        recentGameLines.removeFirst();
    }
}

QString AiBridgeService::configuredProvider() const {
    return llmProvider.isEmpty() ? QString("openai") : llmProvider;
}

QString AiBridgeService::configuredModel() const {
    return configuredProvider() == "anthropic" ? QString("claude-3-5-haiku-latest") : QString("gpt-4o-mini");
}

void AiBridgeService::reloadSettings() {
    const bool wasEnabled = enabled;

    enabled = settings->getParameter("AiBridge/enabled", false).toBool();
    sendOutput = settings->getParameter("AiBridge/sendOutput", true).toBool();
    consumeCommands = settings->getParameter("AiBridge/consumeCommands", false).toBool();
    runInternalMcp = settings->getParameter("AiBridge/runInternalMcp", true).toBool();
    embeddedMode = settings->getParameter("AiBridge/embeddedMode", true).toBool();
    observerEnabled = settings->getParameter("AiBridge/observerEnabled", false).toBool();
    pollIntervalMs = settings->getParameter("AiBridge/pollIntervalMs", 1200).toInt();
    baseUrl = settings->getQStringNotBlank("AiBridge/baseUrl", "http://127.0.0.1:8787");
    token = settings->getParameter("AiBridge/token", "").toString().trimmed();
    llmProvider = settings->getParameter("AiBridge/llmProvider", "openai").toString().trimmed().toLower();
    openAiApiKey = settings->getParameter("AiBridge/openAiApiKey", "").toString().trimmed();
    anthropicApiKey = settings->getParameter("AiBridge/anthropicApiKey", "").toString().trimmed();
    mcpEntryPath = settings->getParameter("AiBridge/mcpEntryPath", "").toString().trimmed();
    nodeExecutable = settings->getParameter("AiBridge/nodeExecutable", "node").toString().trimmed();

    if (pollIntervalMs < 250) {
        pollIntervalMs = 250;
    }

    if (enabled && consumeCommands && !embeddedMode) {
        pollTimer->start(pollIntervalMs);
    } else {
        pollTimer->stop();
    }

    if (enabled) {
        this->updateInternalMcpState();
        if (!wasEnabled) {
            if (embeddedMode) {
                emit statusMessage("AI embedded mode enabled.");
            } else {
                emit statusMessage("AI bridge enabled. Checking local bridge health...");
            }
        }
        if (embeddedMode) {
            healthTimer->stop();
            healthKnown = false;
        } else {
            healthTimer->start(6000);
            this->checkHealth();
        }
    } else {
        this->updateInternalMcpState();
        healthTimer->stop();
        healthKnown = false;
        if (wasEnabled) {
            emit statusMessage("AI bridge disabled.");
        }
    }
}

void AiBridgeService::setObserverMode(bool enabledValue) {
    observerEnabled = enabledValue;
    settings->setParameter("AiBridge/observerEnabled", enabledValue);
    emit statusMessage(QString("Observer mode %1.").arg(enabledValue ? "enabled" : "disabled"));
}

bool AiBridgeService::isObserverModeEnabled() const {
    return observerEnabled;
}

void AiBridgeService::updateInternalMcpState() {
    if (embeddedMode) {
        this->stopInternalMcp();
        return;
    }

    if (enabled && runInternalMcp) {
        this->startInternalMcp();
    } else {
        this->stopInternalMcp();
    }
}

QString AiBridgeService::resolveMcpEntryPath() const {
    if (!mcpEntryPath.isEmpty() && QFileInfo::exists(mcpEntryPath)) {
        return QFileInfo(mcpEntryPath).absoluteFilePath();
    }

    const QString appDir = QCoreApplication::applicationDirPath();
    const QStringList candidates = {
        QDir::cleanPath(appDir + "/../../../../dist/index.js"),
        QDir::cleanPath(QDir::currentPath() + "/dist/index.js"),
        QDir::cleanPath(QDir::currentPath() + "/../dist/index.js")
    };

    for (const QString& candidate : candidates) {
        if (QFileInfo::exists(candidate)) {
            return QFileInfo(candidate).absoluteFilePath();
        }
    }

    return QString();
}

int AiBridgeService::bridgePort() const {
    const int urlPort = QUrl(baseUrl).port();
    return urlPort > 0 ? urlPort : 8787;
}

void AiBridgeService::startInternalMcp() {
    if (mcpProcess->state() == QProcess::Running) {
        return;
    }

    const QString entryPath = this->resolveMcpEntryPath();
    if (entryPath.isEmpty()) {
        emit statusMessage("Internal MCP server not started: MCP entry path not found.");
        return;
    }

    const QString executable = nodeExecutable.isEmpty() ? QString("node") : nodeExecutable;
    QStringList arguments;
    arguments << entryPath;

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("DR_BRIDGE_PORT", QString::number(this->bridgePort()));
    if (!token.isEmpty()) {
        env.insert("DR_BRIDGE_TOKEN", token);
    }

    const QString provider = llmProvider.isEmpty() ? QString("openai") : llmProvider;
    env.insert("AI_LLM_PROVIDER", provider);
    if (provider == "anthropic" && !anthropicApiKey.isEmpty()) {
        env.insert("ANTHROPIC_API_KEY", anthropicApiKey);
    } else if (!openAiApiKey.isEmpty()) {
        env.insert("OPENAI_API_KEY", openAiApiKey);
    }

    mcpProcess->setProcessEnvironment(env);
    mcpProcess->setWorkingDirectory(QFileInfo(entryPath).absolutePath());
    mcpProcess->start(executable, arguments);

    if (!mcpProcess->waitForStarted(2500)) {
        emit statusMessage("Internal MCP server failed to start. Verify Node and MCP entry path.");
        return;
    }

    emit statusMessage(QString("Internal MCP server started on port %1.").arg(this->bridgePort()));
}

void AiBridgeService::stopInternalMcp() {
    if (mcpProcess->state() != QProcess::Running) {
        return;
    }

    mcpProcess->terminate();
    if (!mcpProcess->waitForFinished(1500)) {
        mcpProcess->kill();
        mcpProcess->waitForFinished(1000);
    }
}

void AiBridgeService::submitOutput(const QByteArray& text, bool prompt) {
    if (!enabled) {
        return;
    }

    QString cleanText = QString::fromUtf8(text).replace("\r", "").trimmed();
    if (cleanText.isEmpty()) {
        return;
    }

    if (cleanText.size() > 4000) {
        cleanText = cleanText.left(4000);
    }

    this->appendGameContext(cleanText);
    this->maybeRunObserverTick(cleanText, prompt);

    if (embeddedMode || !sendOutput) {
        return;
    }

    QJsonObject body;
    body.insert("text", cleanText);
    body.insert("source", prompt ? "prompt" : "game");

    QNetworkRequest request = this->buildRequest("/io/output");
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");

    QNetworkReply* reply = network->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, reply, &QNetworkReply::deleteLater);
}

bool AiBridgeService::isHighSignalObserverEvent(const QString& cleanText) const {
    const QString event = cleanText.toLower();
    if (event.isEmpty()) {
        return false;
    }

    const QList<QRegularExpression> patterns = {
        QRegularExpression("\\b(says|ask|asks|asked|tells you|whispers|whispered|yells|shouts)\\b", QRegularExpression::CaseInsensitiveOption),
        QRegularExpression("\\b(attacks|attacking|engages|engaged|stunned|bleeding|dies|dead|wounded|retreats|roundtime)\\b", QRegularExpression::CaseInsensitiveOption),
        QRegularExpression("\\b(you are (?:stunned|bleeding|off balance|immobilized)|you (?:must wait|can\\'t|cannot))\\b", QRegularExpression::CaseInsensitiveOption),
        QRegularExpression("\\b(arrives|arrive|enters|leaves|departs|appears)\\b", QRegularExpression::CaseInsensitiveOption),
        QRegularExpression("\\?", QRegularExpression::CaseInsensitiveOption)
    };

    for (const QRegularExpression& pattern : patterns) {
        if (pattern.match(event).hasMatch()) {
            return true;
        }
    }

    return false;
}

QString AiBridgeService::buildObserverPrompt(const QString& cleanText, bool prompt, bool highSignal) const {
    const QString source = prompt ? QString("prompt") : QString("game output");
    const QString guidance = highSignal
        ? QString("High-signal event detected. React immediately if needed. If another player is speaking to you or asking a question, include one short socially appropriate response and optionally one command proposal. If proposing a command, output exactly one line starting with 'CMD: '.")
        : QString("Routine observer check. Give one concise recommendation based on current context and only propose a command if it is clearly useful now.");

    return QString(
        "Observer mode tick.\n"
        "Latest %1 line:\n%2\n\n"
        "%3"
    ).arg(source, cleanText, guidance);
}

void AiBridgeService::maybeRunObserverTick(const QString& cleanText, bool prompt) {
    if (!enabled || !observerEnabled || observerRequestInFlight) {
        return;
    }

    if (cleanText.isEmpty()) {
        return;
    }

    const bool highSignal = this->isHighSignalObserverEvent(cleanText);
    const qint64 minIntervalMs = highSignal ? 7000 : (prompt ? 14000 : 25000);
    const QString fingerprint = cleanText.left(220).trimmed().simplified().toLower();

    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    if ((nowMs - lastObserverRequestMs) < minIntervalMs) {
        return;
    }

    if (!highSignal && fingerprint == lastObserverEventFingerprint && (nowMs - lastObserverRequestMs) < 60000) {
        return;
    }

    lastObserverRequestMs = nowMs;
    lastObserverEventFingerprint = fingerprint;
    observerRequestInFlight = true;
    this->requestAssistantResponse(this->buildObserverPrompt(cleanText, prompt, highSignal));
}

void AiBridgeService::showAssistantHelp() {
    emit statusMessage("Commands: /ai <prompt>, /aiwiki <topic>, /aimodel, /aiobserve on|off|status, /aigo <location>, /airoute <location>, /aimapnav on|off|status, /aistop, /aipending, /aiapprove [id], /aireject [id], /aihelp");
}

void AiBridgeService::showAssistantModel() {
    emit statusMessage(QString("Provider: %1 | Model: %2").arg(this->configuredProvider(), this->configuredModel()));
}

void AiBridgeService::requestAssistantResponse(const QString& prompt) {
    const QString userPrompt = prompt.trimmed();
    if (userPrompt.isEmpty()) {
        observerRequestInFlight = false;
        emit statusMessage("Usage: /ai <prompt>");
        return;
    }

    if (this->isLocationQuestion(userPrompt)) {
        const QString inferred = this->inferCurrentLocationFromContext();
        if (!inferred.isEmpty()) {
            emit statusMessage(QString("Current location from recent game output: %1").arg(inferred));
            observerRequestInFlight = false;
            return;
        }
    }

    const QString provider = this->configuredProvider();
    const QString model = this->configuredModel();
    const QString systemPrompt = this->buildCoachSystemPrompt();
    const QString contextBlock = this->buildRecentGameContext();

    const QString userContent = QString(
        "Player request:\n%1\n\n"
        "Recent DragonRealms game data (chronological):\n%2\n\n"
        "Respond only as a DragonRealms gameplay coach."
    ).arg(userPrompt, contextBlock);

    QNetworkRequest request;
    QJsonObject body;

    if (provider == "anthropic") {
        if (anthropicApiKey.isEmpty()) {
            observerRequestInFlight = false;
            emit statusMessage("Anthropic API key is missing. Set it in Script Settings -> AI.");
            return;
        }

        request = QNetworkRequest(QUrl("https://api.anthropic.com/v1/messages"));
        request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        request.setRawHeader("x-api-key", anthropicApiKey.toUtf8());
        request.setRawHeader("anthropic-version", "2023-06-01");

        QJsonArray messages;
        QJsonObject message;
        message.insert("role", "user");
        message.insert("content", userContent);
        messages.append(message);

        body.insert("model", model);
        body.insert("max_tokens", 600);
        body.insert("system", systemPrompt);
        body.insert("messages", messages);
    } else {
        if (openAiApiKey.isEmpty()) {
            observerRequestInFlight = false;
            emit statusMessage("OpenAI API key is missing. Set it in Script Settings -> AI.");
            return;
        }

        request = QNetworkRequest(QUrl("https://api.openai.com/v1/chat/completions"));
        request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        request.setRawHeader("Authorization", QString("Bearer %1").arg(openAiApiKey).toUtf8());

        QJsonArray messages;
        QJsonObject systemMessage;
        systemMessage.insert("role", "system");
        systemMessage.insert("content", systemPrompt);
        messages.append(systemMessage);

        QJsonObject message;
        message.insert("role", "user");
        message.insert("content", userContent);
        messages.append(message);

        body.insert("model", model);
        body.insert("messages", messages);
        body.insert("temperature", 0.4);
    }

    emit statusMessage(QString("Thinking (%1)...").arg(provider));

    QNetworkReply* reply = network->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, provider]() {
        const QByteArray payload = reply->readAll();
        const int httpCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();

        if (reply->error() != QNetworkReply::NoError) {
            QString detail = QString::fromUtf8(payload).trimmed();
            if (detail.length() > 280) {
                detail = detail.left(280) + "...";
            }
            if (detail.isEmpty()) {
                emit statusMessage(QString("AI request failed (%1): %2").arg(httpCode).arg(reply->errorString()));
            } else {
                emit statusMessage(QString("AI request failed (%1): %2").arg(httpCode).arg(detail));
            }
            observerRequestInFlight = false;
            reply->deleteLater();
            return;
        }

        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
            emit statusMessage("AI response parse error.");
            observerRequestInFlight = false;
            reply->deleteLater();
            return;
        }

        QString answer;
        const QJsonObject root = doc.object();

        if (provider == "anthropic") {
            const QJsonArray content = root.value("content").toArray();
            for (const QJsonValue& item : content) {
                const QJsonObject part = item.toObject();
                if (part.value("type").toString() == "text") {
                    answer += part.value("text").toString();
                }
            }
        } else {
            const QJsonArray choices = root.value("choices").toArray();
            if (!choices.isEmpty()) {
                answer = choices.at(0).toObject().value("message").toObject().value("content").toString();
            }
        }

        answer = answer.trimmed();
        if (answer.isEmpty()) {
            emit statusMessage("AI returned no text.");
            observerRequestInFlight = false;
            reply->deleteLater();
            return;
        }

        QStringList nonCommandLines;
        const QStringList lines = answer.split('\n');
        for (const QString& rawLine : lines) {
            const QString line = rawLine.trimmed();
            if (line.startsWith("CMD:", Qt::CaseInsensitive)) {
                const QString proposed = line.mid(4).trimmed();
                if (!proposed.isEmpty()) {
                    emit commandProposed(proposed);
                }
                continue;
            }
            nonCommandLines.append(rawLine);
        }

        answer = nonCommandLines.join("\n").trimmed();
        if (answer.isEmpty()) {
            answer = "(No narrative response. Proposed commands were queued for approval.)";
        }

        if (answer.length() > 3000) {
            answer = answer.left(3000) + "...";
        }

        emit statusMessage(answer);
        observerRequestInFlight = false;
        reply->deleteLater();
    });
}

void AiBridgeService::requestElanthipediaSummary(const QString& topic) {
    const QString query = topic.trimmed();
    if (query.isEmpty()) {
        emit statusMessage("Usage: /aiwiki <topic>");
        return;
    }

    emit statusMessage("Searching Elanthipedia...");

    QUrl searchUrl("https://elanthipedia.play.net/api.php");
    QUrlQuery searchQuery;
    searchQuery.addQueryItem("action", "opensearch");
    searchQuery.addQueryItem("search", query);
    searchQuery.addQueryItem("limit", "1");
    searchQuery.addQueryItem("namespace", "0");
    searchQuery.addQueryItem("format", "json");
    searchUrl.setQuery(searchQuery);

    QNetworkReply* searchReply = network->get(QNetworkRequest(searchUrl));
    connect(searchReply, &QNetworkReply::finished, this, [this, searchReply]() {
        const QByteArray payload = searchReply->readAll();
        if (searchReply->error() != QNetworkReply::NoError) {
            emit statusMessage("Elanthipedia search failed.");
            searchReply->deleteLater();
            return;
        }

        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isArray()) {
            emit statusMessage("Elanthipedia search parse error.");
            searchReply->deleteLater();
            return;
        }

        const QJsonArray root = doc.array();
        if (root.size() < 2 || !root.at(1).isArray() || root.at(1).toArray().isEmpty()) {
            emit statusMessage("No Elanthipedia results found.");
            searchReply->deleteLater();
            return;
        }

        const QString pageTitle = root.at(1).toArray().at(0).toString().trimmed();
        if (pageTitle.isEmpty()) {
            emit statusMessage("No Elanthipedia results found.");
            searchReply->deleteLater();
            return;
        }

        QUrl pageUrl("https://elanthipedia.play.net/api.php");
        QUrlQuery pageQuery;
        pageQuery.addQueryItem("action", "parse");
        pageQuery.addQueryItem("page", pageTitle);
        pageQuery.addQueryItem("prop", "text");
        pageQuery.addQueryItem("format", "json");
        pageQuery.addQueryItem("formatversion", "2");
        pageUrl.setQuery(pageQuery);

        QNetworkReply* pageReply = network->get(QNetworkRequest(pageUrl));
        connect(pageReply, &QNetworkReply::finished, this, [this, pageReply, pageTitle]() {
            const QByteArray pagePayload = pageReply->readAll();
            if (pageReply->error() != QNetworkReply::NoError) {
                emit statusMessage("Elanthipedia page fetch failed.");
                pageReply->deleteLater();
                return;
            }

            QJsonParseError pageParseError;
            const QJsonDocument pageDoc = QJsonDocument::fromJson(pagePayload, &pageParseError);
            if (pageParseError.error != QJsonParseError::NoError || !pageDoc.isObject()) {
                emit statusMessage("Elanthipedia page parse error.");
                pageReply->deleteLater();
                return;
            }

            QString html = pageDoc.object().value("parse").toObject().value("text").toString();
            html.remove(QRegularExpression("<script[^>]*>[\\s\\S]*?</script>", QRegularExpression::CaseInsensitiveOption));
            html.remove(QRegularExpression("<style[^>]*>[\\s\\S]*?</style>", QRegularExpression::CaseInsensitiveOption));
            QString text = html;
            text.remove(QRegularExpression("<[^>]+>"));
            text.replace("&nbsp;", " ");
            text.replace("&amp;", "&");
            text.replace("&lt;", "<");
            text.replace("&gt;", ">");
            text = text.simplified();
            if (text.length() > 1600) {
                text = text.left(1600) + "...";
            }

            emit statusMessage(QString("Elanthipedia: %1\n%2").arg(pageTitle, text));
            pageReply->deleteLater();
        });

        searchReply->deleteLater();
    });
}

void AiBridgeService::pollCommands() {
    if (!enabled || !consumeCommands || embeddedMode) {
        return;
    }

    QNetworkReply* reply = network->get(this->buildRequest("/io/commands?limit=5"));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        QByteArray payload = reply->readAll();
        reply->deleteLater();

        if (reply->error() != QNetworkReply::NoError) {
            return;
        }

        QJsonParseError parseError;
        QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
            return;
        }

        QJsonArray commands = doc.object().value("commands").toArray();
        for (const QJsonValue& commandValue : commands) {
            QString command;
            if (commandValue.isObject()) {
                command = commandValue.toObject().value("command").toString().trimmed();
            } else if (commandValue.isString()) {
                command = commandValue.toString().trimmed();
            }

            if (!command.isEmpty()) {
                emit commandReceived(command);
            }
        }
    });
}

void AiBridgeService::checkHealth() {
    if (!enabled || embeddedMode) {
        return;
    }

    QNetworkReply* reply = network->get(this->buildRequest("/health"));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const bool ok = reply->error() == QNetworkReply::NoError && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200;
        reply->deleteLater();

        if (!healthKnown || healthOk != ok) {
            healthKnown = true;
            healthOk = ok;
            if (ok) {
                emit statusMessage("AI bridge connected.");
            } else {
                emit statusMessage("AI bridge unavailable. Verify MCP bridge is running.");
            }
        }
    });
}

QNetworkRequest AiBridgeService::buildRequest(const QString& path) const {
    QString normalizedBase = baseUrl;
    while (normalizedBase.endsWith('/')) {
        normalizedBase.chop(1);
    }

    QString normalizedPath = path;
    if (!normalizedPath.startsWith('/')) {
        normalizedPath.prepend('/');
    }

    QNetworkRequest request(QUrl(normalizedBase + normalizedPath));
    this->applyAuth(request);
    return request;
}

void AiBridgeService::applyAuth(QNetworkRequest& request) const {
    if (token.isEmpty()) {
        return;
    }

    request.setRawHeader("X-DR-Token", token.toUtf8());
    request.setRawHeader("Authorization", QString("Bearer %1").arg(token).toUtf8());
}