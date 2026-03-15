#ifndef SCRIPTSETTINGSDIALOG_H
#define SCRIPTSETTINGSDIALOG_H

#include <QDialog>
#include <QFileDialog>
#include <QStringList>

class MainWindow;
class ClientSettings;

namespace Ui {
    class ScriptSettingsDialog;
}

class ScriptSettingsDialog : public QDialog {
    Q_OBJECT

public:
    explicit ScriptSettingsDialog(QWidget *parent = 0);
    ~ScriptSettingsDialog();

private:    
    void loadSettings();
    QString resolveOllamaExecutable() const;
    QStringList detectOllamaModels() const;
    bool isLikelyUnsuitableAgentModel(const QString& modelName) const;
    bool isAgentCapableOllamaModel(const QString& ollamaExecutable, const QString& modelName) const;
    void loadOllamaModels(bool preserveCurrentSelection = true);

    void saveChanges();
    void cancelChanges();

    Ui::ScriptSettingsDialog *ui;

    MainWindow* mainWindow;
    ClientSettings* settings;

    QHash<QString, QVariant> changeList;

signals:
    void settingsChanged();

private slots:
    void browse();
    void refreshOllamaModels();
    void inputChanged();
    void okPressed();
    void applyPressed();
    void cancelPressed();
    void inputEdited(QString);
};

#endif // SCRIPTSETTINGSDIALOG_H
