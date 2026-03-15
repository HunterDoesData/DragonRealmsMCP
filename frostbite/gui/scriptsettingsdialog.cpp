#include "scriptsettingsdialog.h"
#include "ui_scriptsettingsdialog.h"

#include "mainwindow.h"
#include "clientsettings.h"
#include "defaultvalues.h"

#include <QProcess>
#include <QRegularExpression>

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

    ui->scriptInterpreterButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptInterpreterInput));
    ui->scriptEntryButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptEntryInput));
    ui->scriptPathButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->scriptPathInput));
    ui->lichRubyButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->lichRubyInput));
    ui->lichLocationButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->lichLocationInput));
    ui->mcpEntryPathButton->setProperty("input", QVariant::fromValue<QLineEdit*>(ui->mcpEntryPathInput));

    auto portValidator = new QRegExpValidator(QRegExp("^(\\s*|\\d+)$"), this);
    ui->scriptPortInput->setValidator(portValidator);
    ui->streamingPortInput->setValidator(portValidator);
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
            << ui->aiBridgeBaseUrlInput << ui->aiBridgeTokenInput;

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
    QProcess process;
    process.start("ollama", QStringList() << "list");

    if (!process.waitForStarted(800)) {
        return QStringList();
    }

    if (!process.waitForFinished(5000)) {
        process.kill();
        process.waitForFinished(1000);
        return QStringList();
    }

    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) {
        return QStringList();
    }

    const QString output = QString::fromUtf8(process.readAllStandardOutput());
    QStringList models;
    const QStringList lines = output.split('\n', Qt::SkipEmptyParts);
    bool sawHeader = false;
    for (const QString& rawLine : lines) {
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
        if (!model.isEmpty() && !models.contains(model)) {
            models.append(model);
        }
    }

    models.sort(Qt::CaseInsensitive);
    return models;
}

void ScriptSettingsDialog::loadOllamaModels(bool preserveCurrentSelection) {
    const QString previousValue = preserveCurrentSelection
                                      ? ui->ollamaModelInput->currentText().trimmed()
                                      : settings->getParameter("AiBridge/ollamaModel", "deepseek-r1:8b").toString().trimmed();

    const QStringList detectedModels = detectOllamaModels();
    ui->ollamaModelInput->blockSignals(true);
    ui->ollamaModelInput->clear();

    if (!detectedModels.isEmpty()) {
        ui->ollamaModelInput->addItems(detectedModels);
        ui->ollamaModelInput->setToolTip("Detected from local 'ollama list'.");
    } else {
        ui->ollamaModelInput->setToolTip("No local models detected. Install with 'ollama pull <model>'.");
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
