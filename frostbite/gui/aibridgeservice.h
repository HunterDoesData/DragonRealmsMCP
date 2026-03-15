#ifndef AIBRIDGESERVICE_H
#define AIBRIDGESERVICE_H

#include <QObject>
#include <QByteArray>
#include <QString>
#include <QStringList>

class ClientSettings;
class QProcess;
class QNetworkReply;
class QNetworkAccessManager;
class QNetworkRequest;
class QTimer;

class AiBridgeService : public QObject {
    Q_OBJECT

public:
    explicit AiBridgeService(QObject* parent = 0);

    void reloadSettings();
    void submitOutput(const QByteArray& text, bool prompt);
    void requestAssistantResponse(const QString& prompt);
    void requestElanthipediaSummary(const QString& topic);
    void showAssistantHelp();
    void showAssistantModel();
    void setObserverMode(bool enabled);
    bool isObserverModeEnabled() const;
    void setAutonomyMode(bool enabled);
    bool isAutonomyModeEnabled() const;
    bool setAutonomySwitch(const QString& name, bool enabled);
    QStringList autonomySwitches() const;
    QString autonomySwitchSummary() const;
    bool isEnabled() const;

signals:
    void commandReceived(const QString& command);
    void commandProposed(const QString& command);
    void statusMessage(const QString& message);
    void autonomyActivated();

private slots:
    void pollCommands();
    void checkHealth();

private:
    QString buildCoachSystemPrompt() const;
    QString buildRecentGameContext() const;
    bool isLocationQuestion(const QString& prompt) const;
    QString inferCurrentLocationFromContext() const;
    void appendGameContext(const QString& text);
    void maybeRunObserverTick(const QString& cleanText, bool prompt);
    bool isHighSignalObserverEvent(const QString& cleanText) const;
    QString buildObserverPrompt(const QString& cleanText, bool prompt, bool highSignal) const;
    QNetworkRequest buildRequest(const QString& path) const;
    void applyAuth(QNetworkRequest& request) const;
    void updateInternalMcpState();
    void startInternalMcp();
    void stopInternalMcp();
    QString resolveMcpEntryPath() const;
    int bridgePort() const;
    QString configuredProvider() const;
    QString configuredModel() const;
    QString normalizeAutonomySwitch(const QString& name) const;
    QStringList supportedAutonomySwitches() const;

    ClientSettings* settings;
    QNetworkAccessManager* network;
    QProcess* mcpProcess;
    QTimer* pollTimer;
    QTimer* healthTimer;

    bool enabled;
    bool sendOutput;
    bool consumeCommands;
    bool runInternalMcp;
    bool embeddedMode;
    int pollIntervalMs;
    bool healthOk;
    bool healthKnown;
    bool observerEnabled;
    bool autonomyEnabled;
    QStringList autonomySwitchList;
    bool observerRequestInFlight;
    qint64 lastObserverRequestMs;
    QString lastObserverEventFingerprint;
    QString baseUrl;
    QString token;
    QString llmProvider;
    QString ollamaModel;
    QString ollamaBaseUrl;
    QString openAiApiKey;
    QString anthropicApiKey;
    QString mcpEntryPath;
    QString nodeExecutable;
    QStringList recentGameLines;
};

#endif // AIBRIDGESERVICE_H