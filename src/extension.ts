// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { TextDecoder } from 'util';

const execAsync = promisify(exec);

// Create an output channel for logging
const outputChannel = vscode.window.createOutputChannel('Code History');

// Command manager to handle registration/unregistration
class CommandManager {
  private static instance: CommandManager;
  private registeredCommands: Map<string, vscode.Disposable> = new Map();
  
  private constructor() {}
  
  public static getInstance(): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager();
    }
    return CommandManager.instance;
  }
  
  public async registerCommand(id: string, callback: (...args: any[]) => any): Promise<vscode.Disposable> {
    // Unregister existing command if it exists
    await this.unregisterCommand(id);
    
    // Register the new command
    const disposable = vscode.commands.registerCommand(id, callback);
    this.registeredCommands.set(id, disposable);
    return disposable;
  }
  
  public async unregisterCommand(id: string): Promise<void> {
    const disposable = this.registeredCommands.get(id);
    if (disposable) {
      disposable.dispose();
      this.registeredCommands.delete(id);
    }
  }
}

function log(message: string): void {
  console.log(message);
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  message: string;
  content: string;
}

// Class for providing CodeLens
class GitHistoryCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    
    // Add a CodeLens for each line
    for (let i = 0; i < document.lineCount; i++) {
      const range = new vscode.Range(i, 0, i, 0);
      const command = {
        title: "Show line history",
        command: "codehistory.showLineHistory",
        arguments: [document.uri, range]
      };
      codeLenses.push(new vscode.CodeLens(range, command));
    }
    
    return codeLenses;
  }

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "codehistory" is now active!');

  // Register the CodeLens provider only if enabled in settings
  let codeLensRegistration: vscode.Disposable | undefined;
  const codeLensProvider = new GitHistoryCodeLensProvider();
  
  function updateCodeLensRegistration() {
    if (codeLensRegistration) {
      codeLensRegistration.dispose();
      codeLensRegistration = undefined;
    }
    
    const config = vscode.workspace.getConfiguration('codehistory');
    const enableCodeLens = config.get<boolean>('enableCodeLens', false);
    
    if (enableCodeLens) {
      codeLensRegistration = vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        codeLensProvider
      );
      context.subscriptions.push(codeLensRegistration);
    }
  }
  
  // Initial setup
  updateCodeLensRegistration();
  
  // Update when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codehistory.enableCodeLens')) {
        updateCodeLensRegistration();
        codeLensProvider.refresh();
      }
    })
  );

  // Register the command that will show history in a peek view
  const lineHistoryDisposable = vscode.commands.registerCommand('codehistory.showLineHistory', async (uri?: vscode.Uri, range?: vscode.Range) => {
    // Show the output channel
    outputChannel.clear();
    log('Command: showLineHistory started');
    
    // First check if git is installed
    try {
      const { stdout: gitVersion } = await execAsync('git --version');
      log(`Git version: ${gitVersion.trim()}`);
    } catch (error) {
      const errorMsg = `Git is not installed or not available in PATH: ${error instanceof Error ? error.message : String(error)}`;
      log(errorMsg);
      vscode.window.showErrorMessage('Git is not installed or not available in PATH. Please install Git to use this extension.');
      return;
    }
    
    // Handle both invocation methods (from context menu or from CodeLens)
    let document: vscode.TextDocument;
    let filePath: string;
    let startLine: number;
    let endLine: number;
    
    if (uri && range) {
      // Called from CodeLens
      document = await vscode.workspace.openTextDocument(uri);
      filePath = uri.fsPath;
      startLine = range.start.line + 1; // Git uses 1-based line numbers
      endLine = range.end.line + 1;
    } else {
      // Called from context menu
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
      }

      document = editor.document;
      
      // Check if the document is saved
      if (document.isDirty) {
        vscode.window.showWarningMessage('Please save the file before viewing its history');
        return;
      }
      
      filePath = document.uri.fsPath;
      const selection = editor.selection;
      
      // If selection is empty, use the current cursor line
      if (selection.isEmpty) {
        startLine = selection.active.line + 1; // Git uses 1-based line numbers
        endLine = startLine;
      } else {
        startLine = selection.start.line + 1;
        endLine = selection.end.line + 1;
      }
    }

    // startLine and endLine are now defined above

    try {
      // Show a loading message
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Loading code history...",
        cancellable: false
      }, async (progress) => {
        try {
          const commits = await getLineHistory(filePath, startLine, endLine);
          
          if (commits.length === 0) {
            vscode.window.showInformationMessage('No history found for the selected lines');
            return;
          }
          
          // Show history in a peek view
          await showHistoryInPeekView(document, startLine - 1, endLine - 1, commits, context);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log(`Error in progress handler: ${errorMessage}`);
          
          // Show output channel with logs
          outputChannel.show(true);
          
          // Create a more user-friendly error message
          let userMessage = `Error retrieving history: ${errorMessage}`;
          
          if (errorMessage.includes("not a git repository") || errorMessage.includes("not in a git repository")) {
            userMessage = "The file is not in a git repository. Git history is only available for files tracked in git.";
          } else if (errorMessage.includes("not tracked in git")) {
            userMessage = "This file is not tracked in git. Only committed files have history.";
          } else if (errorMessage.includes("does not exist in") || errorMessage.includes("no such path")) {
            userMessage = "This file is not tracked in git or has no commit history yet.";
          } else if (errorMessage.includes("no commit history")) {
            userMessage = "The selected lines have no commit history yet.";
          } else if (errorMessage.includes("outside the file's content")) {
            userMessage = "The selected line range is outside the file's content in the repository.";
          }
          
          vscode.window.showErrorMessage(userMessage, "Show Logs")
            .then(selection => {
              if (selection === "Show Logs") {
                outputChannel.show(true);
              }
            });
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Outer error handler: ${errorMessage}`);
      
      // Show output channel with logs
      outputChannel.show(true);
      
      // Create a more user-friendly error message
      let userMessage = `Error: ${errorMessage}`;
      
      if (errorMessage.includes("not a git repository") || errorMessage.includes("not in a git repository")) {
        userMessage = "The file is not in a git repository. Git history is only available for files tracked in git.";
      } else if (errorMessage.includes("not tracked in git")) {
        userMessage = "This file is not tracked in git. Only committed files have history.";
      } else if (errorMessage.includes("does not exist in") || errorMessage.includes("no such path")) {
        userMessage = "This file is not tracked in git or has no commit history yet.";
      } else if (errorMessage.includes("no commit history")) {
        userMessage = "The selected lines have no commit history yet.";
      } else if (errorMessage.includes("outside the file's content")) {
        userMessage = "The selected line range is outside the file's content in the repository.";
      }
      
      vscode.window.showErrorMessage(userMessage, "Show Logs")
        .then(selection => {
          if (selection === "Show Logs") {
            outputChannel.show(true);
          }
        });
    }
  });

  context.subscriptions.push(
    lineHistoryDisposable
    // Don't register nextCommit and prevCommit here - they're registered dynamically when needed
  );
}

async function getLineHistory(filePath: string, startLine: number, endLine: number): Promise<CommitInfo[]> {
  try {
    log(`Getting history for file: ${filePath} (lines ${startLine}-${endLine})`);
    
    // First check if the file is in a git repository
    try {
      // Get the directory of the file
      const fileDir = path.dirname(filePath);
      log(`File directory: ${fileDir}`);
      
      // Find git repository root
      let gitRootPath = '';
      
      // Try to get the git root using git command first
      try {
        // Use the file's directory as the working directory for git
        const { stdout } = await execAsync(`git -C "${fileDir}" rev-parse --show-toplevel`);
        gitRootPath = stdout.trim();
        log(`Git root from command: ${gitRootPath}`);
        
        if (!gitRootPath) {
          throw new Error("Empty git root path");
        }
      } catch (gitCmdError) {
        log(`Git command error: ${gitCmdError instanceof Error ? gitCmdError.message : String(gitCmdError)}`);
        
        // Fallback to manual .git directory detection
        let currentDir = fileDir;
        let foundGitDir = false;
        
        while (currentDir !== path.parse(currentDir).root) {
          log(`Checking for .git in: ${currentDir}`);
          const gitDirPath = path.join(currentDir, '.git');
          
          if (fs.existsSync(gitDirPath)) {
            gitRootPath = currentDir;
            foundGitDir = true;
            log(`Found git repository at: ${gitRootPath}`);
            break;
          }
          
          currentDir = path.dirname(currentDir);
        }
        
        if (!foundGitDir) {
          log('No .git directory found in any parent directory');
          throw new Error("Not a git repository");
        }
      }
      
      // Check if the file is tracked by git
      try {
        // Use git ls-files to check if the file is tracked
        const relativeFilePath = path.relative(gitRootPath, filePath);
        log(`Relative file path: ${relativeFilePath}`);
        
        const { stdout: lsFilesOutput } = await execAsync(`git -C "${gitRootPath}" ls-files --error-unmatch "${relativeFilePath}"`);
        log(`Git ls-files output: ${lsFilesOutput.trim()}`);
      } catch (lsFilesError) {
        log(`File not tracked in git: ${lsFilesError instanceof Error ? lsFilesError.message : String(lsFilesError)}`);
        throw new Error("File is not tracked in git");
      }
      
    } catch (error) {
      log(`Repository check error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.message === "File is not tracked in git") {
        throw new Error("The file is not tracked in git. Only files committed to the repository have history.");
      } else {
        throw new Error("The file is not in a git repository");
      }
    }
    
    // Get the git root directory
    const { stdout: gitRootOutput } = await execAsync(`git -C "${path.dirname(filePath)}" rev-parse --show-toplevel`);
    const gitRootPath = gitRootOutput.trim();
    log(`Git root path: ${gitRootPath}`);
    
    // Get the relative path to the file from the git root
    const relativeFilePath = path.relative(gitRootPath, filePath);
    log(`Relative file path for git commands: ${relativeFilePath}`);
    
    // Get the commit history for the specified lines
    // Use -p to include the patch/diff in the output
    const gitLogCommand = `git -C "${gitRootPath}" log --format="%H|%ad|%an|%s" --date=short -p -L ${startLine},${endLine}:${relativeFilePath}`;
    log(`Executing git log command: ${gitLogCommand}`);
    
    let logOutput;
    try {
      const { stdout } = await execAsync(gitLogCommand);
      logOutput = stdout;
      
      if (!logOutput.trim()) {
        log('Git log command returned empty output');
        return [];
      }
      
      log(`Git log output length: ${logOutput.length} characters`);
    } catch (logError) {
      log(`Error executing git log command: ${logError instanceof Error ? logError.message : String(logError)}`);
      
      // Check for specific error messages
      const errorMsg = logError instanceof Error ? logError.message : String(logError);
      if (errorMsg.includes("no such path") || errorMsg.includes("does not exist in")) {
        throw new Error("This file or the selected lines have no commit history yet");
      } else if (errorMsg.includes("has only")) {
        throw new Error("The selected line range is outside the file's content in the repository");
      } else {
        throw logError;
      }
    }

    const commits: CommitInfo[] = [];
    const commitChunks = logOutput.split(/^commit /m).filter(Boolean);

    for (const chunk of commitChunks) {
      const lines = chunk.trim().split('\n');
      const [hash, date, author, message] = lines[0].split('|');
      
      // Extract the content part (after the diff header)
      const contentStartIndex = lines.findIndex(line => line.startsWith('@@'));
      let content = '';
      
      if (contentStartIndex !== -1) {
        // Get only the lines that start with '+' or ' ' (added or unchanged lines)
        // and remove the prefix
        content = lines.slice(contentStartIndex + 1)
          .filter(line => line.startsWith('+') || line.startsWith(' '))
          .map(line => line.startsWith('+') ? line.substring(1) : line.startsWith(' ') ? line.substring(1) : line)
          .join('\n');
      }

      commits.push({
        hash,
        date,
        author,
        message,
        content
      });
    }

    return commits;
  } catch (error) {
    console.error('Error getting line history:', error);
    throw new Error(`Failed to get line history: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Function to show history in a peek view
async function showHistoryInPeekView(
  document: vscode.TextDocument,
  startLine: number,
  endLine: number,
  commits: CommitInfo[],
  context: vscode.ExtensionContext
): Promise<void> {
  // Create a virtual document provider for showing history
  const historyProvider = new class implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;
    
    private _currentCommitIndex = 0;
    
    public get currentCommitIndex(): number {
      return this._currentCommitIndex;
    }
    
    public set currentCommitIndex(value: number) {
      this._currentCommitIndex = value;
      this._onDidChange.fire(this._uri);
    }
    
    private _uri: vscode.Uri;
    
    constructor(uri: vscode.Uri) {
      this._uri = uri;
    }
    
    provideTextDocumentContent(_uri: vscode.Uri): string {
      const commit = commits[this._currentCommitIndex];
      
      // Format the content with commit info at the top
      return [
        `// Commit: ${commit.hash.substring(0, 7)}`,
        `// Author: ${commit.author}`,
        `// Date: ${commit.date}`,
        `// Message: ${commit.message}`,
        `// (${this._currentCommitIndex + 1}/${commits.length})`,
        `// Use 'Next Commit' and 'Previous Commit' buttons to navigate`,
        '',
        // Only show the relevant content from the commit
        // The git log -L command already filters to just the selected lines
        commit.content
      ].join('\n');
    }
  }(vscode.Uri.parse(`git-history:${document.uri.fsPath}`));
  
  // Register the provider
  const registration = vscode.workspace.registerTextDocumentContentProvider('git-history', historyProvider);
  
  // Create the URI for our virtual document
  const uri = vscode.Uri.parse(`git-history:${document.uri.fsPath}`);
  
  // Get the command manager
  const commandManager = CommandManager.getInstance();
  
  // Register commands for navigating between commits
  const nextDisposable = await commandManager.registerCommand('codehistory.nextCommit', () => {
    if (historyProvider.currentCommitIndex < commits.length - 1) {
      historyProvider.currentCommitIndex++;
    }
  });
  
  const prevDisposable = await commandManager.registerCommand('codehistory.prevCommit', () => {
    if (historyProvider.currentCommitIndex > 0) {
      historyProvider.currentCommitIndex--;
    }
  });
  
  // Add navigation buttons to the editor toolbar
  const nextButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  nextButton.text = "$(arrow-right) Next Commit";
  nextButton.command = 'codehistory.nextCommit';
  nextButton.tooltip = 'Show next commit';
  nextButton.show();
  
  const prevButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  prevButton.text = "$(arrow-left) Previous Commit";
  prevButton.command = 'codehistory.prevCommit';
  prevButton.tooltip = 'Show previous commit';
  prevButton.show();
  
  // Show the peek view
  await vscode.commands.executeCommand('editor.action.showReferences',
    document.uri,
    // Position at the start of the selected range
    new vscode.Position(startLine, 0),
    // Create a location that points to our virtual document
    [new vscode.Location(uri, new vscode.Position(0, 0))]
  );
  
  // Clean up when the peek view is closed
  const disposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    const isHistoryOpen = vscode.window.visibleTextEditors.some(
      editor => editor.document.uri.scheme === 'git-history'
    );
    
    if (!isHistoryOpen) {
      log('History view closed, cleaning up resources');
      registration.dispose();
      nextDisposable.dispose();
      prevDisposable.dispose();
      nextButton.dispose();
      prevButton.dispose();
      disposable.dispose();
      
      // Unregister the commands
      const commandManager = CommandManager.getInstance();
      commandManager.unregisterCommand('codehistory.nextCommit');
      commandManager.unregisterCommand('codehistory.prevCommit');
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
