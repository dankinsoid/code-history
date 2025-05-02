// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

// Create an output channel for logging
const outputChannel = vscode.window.createOutputChannel('Code History');

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "codehistory" is now active!');

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const helloWorldDisposable = vscode.commands.registerCommand('codehistory.helloWorld', () => {
    // The code you place here will be executed every time your command is executed
    // Display a message box to the user
    vscode.window.showInformationMessage('Hello World from CodeHistory!');
  });

  const lineHistoryDisposable = vscode.commands.registerCommand('codehistory.showLineHistory', async () => {
    // Show the output channel
    outputChannel.clear();
    outputChannel.show(true);
    
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
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const document = editor.document;
    
    // Check if the document is saved
    if (document.isDirty) {
      vscode.window.showWarningMessage('Please save the file before viewing its history');
      return;
    }
    
    const filePath = document.uri.fsPath;
    const selection = editor.selection;
    
    // If selection is empty, use the current cursor line
    let startLine, endLine;
    if (selection.isEmpty) {
      startLine = selection.active.line + 1; // Git uses 1-based line numbers
      endLine = startLine;
    } else {
      startLine = selection.start.line + 1;
      endLine = selection.end.line + 1;
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
          
          // Create and show the webview panel
          const panel = vscode.window.createWebviewPanel(
            'codeHistory',
            'Code History',
            vscode.ViewColumn.Beside,
            {
              enableScripts: true,
              localResourceRoots: [vscode.Uri.file(context.extensionPath)]
            }
          );
          
          panel.webview.html = getWebviewContent(commits, document.getText(new vscode.Range(
            selection.start.line, 0,
            selection.end.line, document.lineAt(selection.end.line).text.length
          )));
          
          // Handle messages from the webview
          panel.webview.onDidReceiveMessage(
            message => {
              switch (message.command) {
                case 'showCommit':
                  vscode.env.openExternal(vscode.Uri.parse(`https://github.com/user/repo/commit/${message.hash}`));
                  return;
              }
            },
            undefined,
            context.subscriptions
          );
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

  context.subscriptions.push(helloWorldDisposable, lineHistoryDisposable);
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
    const gitLogCommand = `git -C "${gitRootPath}" log --format="%H|%ad|%an|%s" --date=short -L ${startLine},${endLine}:${relativeFilePath}`;
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
        content = lines.slice(contentStartIndex + 1).join('\n');
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

function getWebviewContent(commits: CommitInfo[], currentContent: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code History</title>
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 0;
        margin: 0;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
      }
      .commit {
        margin-bottom: 20px;
        border-bottom: 1px solid var(--vscode-panel-border);
        padding-bottom: 10px;
      }
      .commit-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 10px;
        cursor: pointer;
        padding: 8px;
        background-color: var(--vscode-panel-background);
      }
      .commit-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }
      .commit-info {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .commit-message {
        font-weight: bold;
        margin-bottom: 5px;
      }
      pre {
        background-color: var(--vscode-editor-background);
        padding: 10px;
        overflow: auto;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 3px;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
      }
      .current-content {
        margin-top: 20px;
        padding: 10px;
        border-top: 2px solid var(--vscode-activityBarBadge-background);
      }
      .current-content h3 {
        margin-top: 0;
      }
      .navigation {
        display: flex;
        justify-content: space-between;
        margin-bottom: 15px;
        position: sticky;
        top: 0;
        background-color: var(--vscode-editor-background);
        padding: 10px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        z-index: 10;
      }
      button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 12px;
        cursor: pointer;
        border-radius: 2px;
      }
      button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    </style>
  </head>
  <body>
    <div class="navigation">
      <h2>Code History</h2>
      <div>
        <button id="prev" disabled>Previous</button>
        <span id="counter">1/${commits.length}</span>
        <button id="next" ${commits.length <= 1 ? 'disabled' : ''}>Next</button>
      </div>
    </div>

    <div id="commits">
      ${commits.map((commit, index) => `
        <div class="commit" id="commit-${index}" ${index > 0 ? 'style="display:none;"' : ''}>
          <div class="commit-header" onclick="openCommit('${commit.hash}')">
            <div>
              <div class="commit-message">${escapeHtml(commit.message)}</div>
              <div class="commit-info">${commit.author} - ${commit.date}</div>
            </div>
            <div class="commit-hash">${commit.hash.substring(0, 7)}</div>
          </div>
          <pre>${escapeHtml(commit.content)}</pre>
        </div>
      `).join('')}
    </div>

    <div class="current-content">
      <h3>Current Content</h3>
      <pre>${escapeHtml(currentContent)}</pre>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      let currentIndex = 0;
      const totalCommits = ${commits.length};
      
      function updateCounter() {
        document.getElementById('counter').textContent = \`\${currentIndex + 1}/\${totalCommits}\`;
      }
      
      function showCommit(index) {
        // Hide all commits
        document.querySelectorAll('.commit').forEach(el => {
          el.style.display = 'none';
        });
        
        // Show the selected commit
        document.getElementById(\`commit-\${index}\`).style.display = 'block';
        
        // Update buttons
        document.getElementById('prev').disabled = index === 0;
        document.getElementById('next').disabled = index === totalCommits - 1;
        
        currentIndex = index;
        updateCounter();
      }
      
      document.getElementById('prev').addEventListener('click', () => {
        if (currentIndex > 0) {
          showCommit(currentIndex - 1);
        }
      });
      
      document.getElementById('next').addEventListener('click', () => {
        if (currentIndex < totalCommits - 1) {
          showCommit(currentIndex + 1);
        }
      });
      
      function openCommit(hash) {
        vscode.postMessage({
          command: 'showCommit',
          hash: hash
        });
      }
    </script>
  </body>
  </html>`;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// This method is called when your extension is deactivated
export function deactivate() {}
