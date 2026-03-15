#include "scriptsettingsdialog.h"
#include "ui_scriptsettingsdialog.h"

#include "mainwindow.h"
#include "clientsettings.h"
#include "defaultvalues.h"

#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QProcess>
#include <QRegularExpression>
#include <QStandardPaths>

ScriptSettingsDialog::ScriptSettingsDialog(QWidget *parent) : QDialog(parent), ui(new Ui::ScriptSettingsDialog) {
    ui->setupUi(this);

    mainWindow = (MainWindow*)parent;

    settings = ClientSettings::getInstance();

    ui->scriptInterpreterInput->setObjectName("interpreterPath");
    ui->scriptEntryInput->setObjectName("scriptEntry");
    ui->scriptPathInput->setObjectName("scriptPath");
    ui->scriptExtensionInput->setObjectName("fileExtension");
    ui->scriptPortInput->setObjectName("apiPort");
    ui->lichLocationInput->setObjectName("lichLocation");
    ui->lichRubyInput->setObjectName("lichRuby");
    ui->lichArgumentsInput->setObjectName("lichArguments");
    ui->streamingServerEnabled->setObjectName("streamingServerEnabled");
    ui->streamingPortInput->setObjectName("streamingServerPort");
    ui->internalMcpEnabled->setObjectName("AiBridge/runInternalMcp");
    ui->llmProviderInput->setObjectName("AiBridge/llmProvider");
    ui->ollamaModelInput->setObjectName("AiBridge/ollamaModel");
    ui->openAiApiKeyInput->setObjectName("AiBridge/openAiApiKey");
    ui->anthropicApiKeyInput->setObjectName("AiBridge/anthropicApiKey");
    ui->mcpEntryPathInput->setObjectName("AiBridge/mcpEntryPath");
    ui->nodeExecutableInput->setObjectName("AiBridge/nodeExecutable");
    ui->aiBridgeEnabled->setObjectName("AiBridge/enabled");
    ui->aiEmbeddedModeEnabled->setObjectName("AiBridge/embeddedMode");
    ui->aiSendOutputEnabled->setObjectName("AiBridge/sendOutput");
    ui->aiConsumeCommandsEnabled->setObjectName("AiBridge/consumeCommands");
    ui->aiBridgeBaseUrlInput->setObjectName("AiBridge/baseUrl");
    ui->aiBridgeTokenInput->setObjectName("AiBridge/token");
    ui->aiAutonomyStartupCommandsInput->setObjectName("AiBridge/autonomyStartupCommands");
    ui->aiAutonomyStartupDelayInput->setObjectName("AiBridge/autonomyStartupDelayMs");

    ui->scriptInterpreterButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptInterpreterInput));
    ui->scriptEntryButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptEntryInput));
    ui->scriptPathButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptPathInput));
    ui->lichRubyButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->lichRubyInput));
    ui->lichLocationButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->lichLocationInput));
    ui->mcpEntryPathButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->mcpEntryPathInput));

    auto portValidator = new QRegExpValidator(QRegExp("^(\\s*|\\d+)$"), this);
    ui->scriptPortInput->setValidator(portValidator);
    ui->streamingPortInput->setValidator(portValidator);
    ui->aiAutonomyStartupDelayInput->setValidator(portValidator);
    ui->applyButton->setDisabled(true);

    this->loadSettings();

    connect(ui->scriptInterpreterButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);
    connect(ui->scriptEntryButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);
    connect(ui->scriptPathButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);
    connect(ui->mcpEntryPathButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);

    connect(ui->lichRubyButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);
    connect(ui->lichLocationButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::browse);

    QList<QLineEdit*> inputs;
    inputs << ui->scriptInterpreterInput << ui->scriptEntryInput << ui->scriptPathInput << ui->scriptExtensionInput << ui->scriptPortInput
            << ui->lichRubyInput << ui->lichLocationInput << ui->lichArgumentsInput << ui->streamingPortInput
            << ui->openAiApiKeyInput << ui->anthropicApiKeyInput << ui->mcpEntryPathInput << ui->nodeExecutableInput
            << ui->aiBridgeBaseUrlInput << ui->aiBridgeTokenInput
            << ui->aiAutonomyStartupCommandsInput << ui->aiAutonomyStartupDelayInput;

    foreach(QLineEdit* input, inputs) {
        connect(input, &QLineEdit::editingFinished, this, &ScriptSettingsDialog::inputChanged);
        connect(input, &QLineEdit::textEdited, this, &ScriptSettingsDialog::inputEdited);
    }

    connect(ui->streamingServerEnabled, &QCheckBox::stateChanged, [=](int newState) {
        const QString key = this->ui->streamingServerEnabled->objectName().contains("/")
                                ? this->ui->streamingServerEnabled->objectName()
                                : "Script/" + this->ui->streamingServerEnabled->objectName();
        this->changeList.insert(key,
                                QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->internalMcpEnabled, &QCheckBox::stateChanged, [=](int newState) {
        const QString key = this->ui->internalMcpEnabled->objectName();
        this->changeList.insert(key, QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->aiBridgeEnabled, &QCheckBox::stateChanged, [=](int newState) {
        this->changeList.insert(this->ui->aiBridgeEnabled->objectName(), QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->aiEmbeddedModeEnabled, &QCheckBox::stateChanged, [=](int newState) {
        this->changeList.insert(this->ui->aiEmbeddedModeEnabled->objectName(), QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->aiSendOutputEnabled, &QCheckBox::stateChanged, [=](int newState) {
        this->changeList.insert(this->ui->aiSendOutputEnabled->objectName(), QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->aiConsumeCommandsEnabled, &QCheckBox::stateChanged, [=](int newState) {
        this->changeList.insert(this->ui->aiConsumeCommandsEnabled->objectName(), QVariant(newState == Qt::Checked));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->llmProviderInput, &QComboBox::currentTextChanged, [=](const QString& value) {
        this->changeList.insert(this->ui->llmProviderInput->objectName(), QVariant(value.trimmed().toLower()));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->ollamaModelInput, &QComboBox::currentTextChanged, [=](const QString& value) {
        this->changeList.insert(this->ui->ollamaModelInput->objectName(), QVariant(value.trimmed()));
        this->ui->applyButton->setEnabled(true);
    });

    connect(ui->ollamaRefreshButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::refreshOllamaModels);

    connect(ui->okButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::okPressed);
    connect(ui->applyButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::applyPressed);
    connect(ui->cancelButton, &QAbstractButton::clicked, this, &ScriptSettingsDialog::cancelPressed);
}

QStringList ScriptSettingsDialog::detectOllamaModels() const {
    const QString ollamaExecutable = this->resolveOllamaExecutable();
    if (ollamaExecutable.isEmpty()) {
        return QStringList();
    }

    QProcess process;
    process.start(ollamaExecutable, QStringList() << "list" << "--json");

    if (!process.waitForStarted(800)) {
        return QStringList();
    }

    if (!process.waitForFinished(5000)) {
        process.kill();
        process.waitForFinished(1000);
        return QStringList();
    }

    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) {
        QProcess fallbackProcess;
        fallbackProcess.start(ollamaExecutable, QStringList() << "list");
        if (!fallbackProcess.waitForStarted(800)) {
            return QStringList();
        }
        if (!fallbackProcess.waitForFinished(5000)) {
            fallbackProcess.kill();
            fallbackProcess.waitForFinished(1000);
            return QStringList();
        }
        if (fallbackProcess.exitStatus() != QProcess::NormalExit || fallbackProcess.exitCode() != 0) {
            return QStringList();
        }

        const QString fallbackOutput = QString::fromUtf8(fallbackProcess.readAllStandardOutput());
        QStringList fallbackModels;
        const QStringList fallbackLines = fallbackOutput.split('\n', Qt::SkipEmptyParts);
        bool sawHeader = false;
        for (const QString& rawLine : fallbackLines) {
            const QString line = rawLine.trimmed();
            if (line.isEmpty()) {
                continue;
            }

            if (!sawHeader) {
                sawHeader = true;
                if (line.startsWith("NAME", Qt::CaseInsensitive)) {
                    continue;
                }
            }

            const QStringList parts = line.split(QRegularExpression("\\s+"), Qt::SkipEmptyParts);
            if (parts.isEmpty()) {
                continue;
            }

            const QString model = parts.first().trimmed();
            if (!model.isEmpty() && !fallbackModels.contains(model)) {
                fallbackModels.append(model);
            }
        }
        fallbackModels.sort(Qt::CaseInsensitive);
        return fallbackModels;
    }

    const QString output = QString::fromUtf8(process.readAllStandardOutput());
    QStringList models;
    const QStringList lines = output.split('\n', Qt::SkipEmptyParts);
    for (const QString& rawLine : lines) {
        const QString line = rawLine.trimmed();
        if (line.isEmpty()) {
            continue;
        }

        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(line.toUtf8(), &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
            continue;
        }

        const QJsonObject obj = doc.object();
        QString model = obj.value("name").toString().trimmed();
        if (model.isEmpty()) {
            model = obj.value("model").toString().trimmed();
        }
        if (model.isEmpty()) {
            continue;
        }

        if (!model.isEmpty() && !models.contains(model)) {
            models.append(model);
        }
    }

    models.sort(Qt::CaseInsensitive);
    return models;
}

QString ScriptSettingsDialog::resolveOllamaExecutable() const {
    const QString discovered = QStandardPaths::findExecutable("ollama");
    if (!discovered.isEmpty()) {
        return discovered;
    }

    const QStringList fallbacks = {
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama"
    };

    for (const QString& candidate : fallbacks) {
        if (QFileInfo::exists(candidate)) {
            return candidate;
        }
    }

    return QString();
}

bool ScriptSettingsDialog::isLikelyUnsuitableAgentModel(const QString& modelName) const {
    const QString lowered = modelName.trimmed().toLower();
    if (lowered.isEmpty()) {
        return true;
    }

    const QStringList unsuitableTokens = {
        "embed",
        "embedding",
        "nomic-embed",
        "bge",
        "e5",
        "rerank"
    };

    for (const QString& token : unsuitableTokens) {
        if (lowered.contains(token)) {
            return true;
        }
    }

    return false;
}

bool ScriptSettingsDialog::isAgentCapableOllamaModel(const QString& ollamaExecutable, const QString& modelName) const {
    if (ollamaExecutable.isEmpty() || modelName.trimmed().isEmpty()) {
        return false;
    }

    QProcess showProcess;
    showProcess.start(ollamaExecutable, QStringList() << "show" << modelName << "--json");
    if (showProcess.waitForStarted(700) && showProcess.waitForFinished(2500)
        && showProcess.exitStatus() == QProcess::NormalExit
        && showProcess.exitCode() == 0) {
        const QByteArray payload = showProcess.readAllStandardOutput();

        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
        if (parseError.error == QJsonParseError::NoError && doc.isObject()) {
            const QJsonObject root = doc.object();

            const QJsonValue capabilitiesValue = root.value("capabilities");
            if (capabilitiesValue.isArray()) {
                const QJsonArray capabilities = capabilitiesValue.toArray();
                bool hasCompletionLike = false;
                bool hasEmbeddingOnly = false;
                for (const QJsonValue& item : capabilities) {
                    const QString capability = item.toString().trimmed().toLower();
                    if (capability.contains("chat") || capability.contains("completion") || capability.contains("generate")) {
                        hasCompletionLike = true;
                    }
                    if (capability.contains("embed")) {
                        hasEmbeddingOnly = true;
                    }
                }
                if (hasCompletionLike) {
                    return true;
                }
                if (hasEmbeddingOnly) {
                    return false;
                }
            }

            const QString templateText = root.value("template").toString().trimmed();
            if (!templateText.isEmpty()) {
                return true;
            }
        }

        const QString loweredPayload = QString::fromUtf8(payload).toLower();
        if (loweredPayload.contains("capabilities")
            && loweredPayload.contains("embed")
            && !loweredPayload.contains("chat")
            && !loweredPayload.contains("completion")
            && !loweredPayload.contains("generate")) {
            return false;
        }
    }

    QProcess modelfileProcess;
    modelfileProcess.start(ollamaExecutable, QStringList() << "show" << modelName << "--modelfile");
    if (modelfileProcess.waitForStarted(700) && modelfileProcess.waitForFinished(2500)
        && modelfileProcess.exitStatus() == QProcess::NormalExit
        && modelfileProcess.exitCode() == 0) {
        const QString modelfileText = QString::fromUtf8(modelfileProcess.readAllStandardOutput()).toLower();
        if (modelfileText.contains("template")) {
            return true;
        }
        if (modelfileText.contains("embed")) {
            return false;
        }
    }

    return !this->isLikelyUnsuitableAgentModel(modelName);
}

void ScriptSettingsDialog::loadOllamaModels(bool preserveCurrentSelection) {
    const QString previousValue = preserveCurrentSelection
                                      ? ui->ollamaModelInput->currentText().trimmed()
                                      : settings->getParameter("AiBridge/ollamaModel", "deepseek-r1:8b").toString().trimmed();

    const QString ollamaExecutable = this->resolveOllamaExecutable();
    const QStringList detectedModels = detectOllamaModels();
    QStringList filteredModels;
    int filteredOutCount = 0;
    for (const QString& model : detectedModels) {
        if (this->isLikelyUnsuitableAgentModel(model)) {
            filteredOutCount++;
            continue;
        }
        if (!this->isAgentCapableOllamaModel(ollamaExecutable, model)) {
            filteredOutCount++;
            continue;
        }
        filteredModels.append(model);
    }

    const bool usedFallbackAllModels = filteredModels.isEmpty() && !detectedModels.isEmpty();
    const QStringList displayedModels = usedFallbackAllModels ? detectedModels : filteredModels;

    ui->ollamaModelInput->blockSignals(true);
    ui->ollamaModelInput->clear();

    if (!displayedModels.isEmpty()) {
        ui->ollamaModelInput->addItems(displayedModels);
        if (usedFallbackAllModels) {
            ui->ollamaModelInput->setToolTip("No clearly chat-capable models detected; showing all local models.");
            ui->ollamaModelHintLabel->setText("No clearly chat-capable models detected. Showing all local models.");
        } else if (filteredOutCount > 0) {
            ui->ollamaModelInput->setToolTip("Showing agent-capable models from local Ollama.");
            ui->ollamaModelHintLabel->setText(QString("Showing agent-capable models (%1 filtered as unsuitable).").arg(filteredOutCount));
        } else {
            ui->ollamaModelInput->setToolTip("Showing agent-capable models from local Ollama.");
            ui->ollamaModelHintLabel->setText("Showing agent-capable models from local Ollama.");
        }
    } else {
        ui->ollamaModelInput->setToolTip("No local models detected. Install with 'ollama pull <model>'.");
        ui->ollamaModelHintLabel->setText("No local Ollama models detected. Install with: ollama pull <model>");
    }

    if (!previousValue.isEmpty()) {
        if (ui->ollamaModelInput->findText(previousValue, Qt::MatchFixedString) < 0) {
            ui->ollamaModelInput->addItem(previousValue);
        }
        ui->ollamaModelInput->setCurrentText(previousValue);
    } else if (ui->ollamaModelInput->count() > 0) {
        ui->ollamaModelInput->setCurrentIndex(0);
    }

    ui->ollamaModelInput->blockSignals(false);
}

void ScriptSettingsDialog::loadSettings() {
    ui->scriptInterpreterInput->setText(settings->getParameter("Script/interpreterPath", "").toString());
    ui->scriptEntryInput->setText(settings->getParameter("Script/scriptEntry", "").toString());
    ui->scriptPathInput->setText(settings->getParameter("Script/scriptPath", "").toString());
    ui->scriptExtensionInput->setText(settings->getParameter("Script/fileExtension", "").toString());
    ui->scriptPortInput->setText(settings->getParameter("Script/apiPort", "").toString());
    ui->lichRubyInput->setText(settings->getParameter("Script/lichRuby", "").toString());
    ui->lichLocationInput->setText(settings->getParameter("Script/lichLocation", "").toString());
    ui->lichArgumentsInput->setText(settings->getParameter("Script/lichArguments", "").toString());
    ui->streamingServerEnabled->setCheckState(
            settings->getParameter("Script/streamingServerEnabled", SCRIPT_STREAMING_ENABLED)
                            .toBool()
                    ? Qt::Checked
                    : Qt::Unchecked);
    ui->streamingPortInput->setText(settings->getParameter("Script/streamingServerPort", "").toString());
    ui->internalMcpEnabled->setCheckState(
            settings->getParameter("AiBridge/runInternalMcp", true).toBool() ? Qt::Checked : Qt::Unchecked);
    {
        const QString provider = settings->getParameter("AiBridge/llmProvider", "openai").toString().trimmed().toLower();
        int idx = ui->llmProviderInput->findText(provider, Qt::MatchFixedString);
        if (idx < 0) {
            idx = 0;
        }
        ui->llmProviderInput->setCurrentIndex(idx);
    }
    this->loadOllamaModels(false);
    ui->openAiApiKeyInput->setText(settings->getParameter("AiBridge/openAiApiKey", "").toString());
    ui->anthropicApiKeyInput->setText(settings->getParameter("AiBridge/anthropicApiKey", "").toString());
    ui->mcpEntryPathInput->setText(settings->getParameter("AiBridge/mcpEntryPath", "").toString());
    ui->nodeExecutableInput->setText(settings->getParameter("AiBridge/nodeExecutable", "node").toString());
    ui->aiBridgeEnabled->setCheckState(settings->getParameter("AiBridge/enabled", false).toBool() ? Qt::Checked : Qt::Unchecked);
    ui->aiEmbeddedModeEnabled->setCheckState(settings->getParameter("AiBridge/embeddedMode", true).toBool() ? Qt::Checked : Qt::Unchecked);
    ui->aiSendOutputEnabled->setCheckState(settings->getParameter("AiBridge/sendOutput", true).toBool() ? Qt::Checked : Qt::Unchecked);
    ui->aiConsumeCommandsEnabled->setCheckState(settings->getParameter("AiBridge/consumeCommands", false).toBool() ? Qt::Checked : Qt::Unchecked);
    ui->aiBridgeBaseUrlInput->setText(settings->getParameter("AiBridge/baseUrl", "http://127.0.0.1:3989").toString());
    ui->aiBridgeTokenInput->setText(settings->getParameter("AiBridge/token", "").toString());
    ui->aiAutonomyStartupCommandsInput->setText(
        settings->getParameter("AiBridge/autonomyStartupCommands", "info, exp, look, inventory, encumbrance, assess").toString());
    ui->aiAutonomyStartupDelayInput->setText(
        settings->getParameter("AiBridge/autonomyStartupDelayMs", "1800").toString());
}

void ScriptSettingsDialog::refreshOllamaModels() {
    this->loadOllamaModels(true);
}

void ScriptSettingsDialog::browse() {
    QPushButton* button = qobject_cast<QPushButton*>(sender());
    if(button != NULL) {
        QLineEdit* input = button->property("input").value<QLineEdit*>();
        QString directory = QDir::toNativeSeparators(QFileDialog::getOpenFileName(this, tr("Find Files"),
                settings->getParameter("Script/" + input->objectName(), QDir::currentPath()).toString()));
        if(!directory.isEmpty()) {
                input->setText(directory);
            const QString key = input->objectName().contains("/") ? input->objectName() : "Script/" + input->objectName();
            changeList.insert(key, QVariant(directory));
                ui->applyButton->setEnabled(true);
        }
    }
}

void ScriptSettingsDialog::inputChanged() {
    QLineEdit* input = qobject_cast<QLineEdit*>(sender());
    if(input != NULL) {
        const QString key = input->objectName().contains("/") ? input->objectName() : "Script/" + input->objectName();
        changeList.insert(key, QVariant(input->text()));
        ui->applyButton->setEnabled(true);
    }
}

void ScriptSettingsDialog::inputEdited(QString) {
    ui->applyButton->setEnabled(true);
}

void ScriptSettingsDialog::saveChanges() {
    QHashIterator<QString, QVariant> i(changeList);
    while (i.hasNext()) {
        i.next();
        settings->setParameter(i.key(), i.value());
    }
    changeList.clear();
    ui->applyButton->setDisabled(true);
    emit settingsChanged();
}

void ScriptSettingsDialog::cancelChanges() {
    if(!changeList.isEmpty()) {
        this->loadSettings();
        changeList.clear();
        ui->applyButton->setDisabled(true);
    }
}

void ScriptSettingsDialog::okPressed() {
    this->saveChanges();
    ui->applyButton->setDisabled(true);
    this->accept();
}

void ScriptSettingsDialog::applyPressed() {
    this->saveChanges();
    ui->applyButton->setDisabled(true);
}

void ScriptSettingsDialog::cancelPressed() {
    this->cancelChanges();
    this->reject();
}

ScriptSettingsDialog::~ScriptSettingsDialog() {
    delete ui;
}
