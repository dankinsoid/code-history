// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
    // First check if git is installed
    try {
      await execAsync('git --version');
    } catch (error) {
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
          if (errorMessage.includes("not a git repository") || errorMessage.includes("not in a git repository")) {
            vscode.window.showErrorMessage("The file is not in a git repository. Git history is only available for files tracked in git.");
          } else if (errorMessage.includes("does not exist in")) {
            vscode.window.showErrorMessage("This file is not tracked in git or has no commit history yet.");
          } else if (errorMessage.includes("no such path")) {
            vscode.window.showErrorMessage("This file is not tracked in git or has no commit history yet.");
          } else {
            vscode.window.showErrorMessage(`Error retrieving history: ${errorMessage}`);
          }
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("not a git repository") || errorMessage.includes("not in a git repository")) {
        vscode.window.showErrorMessage("The file is not in a git repository. Git history is only available for files tracked in git.");
      } else if (errorMessage.includes("does not exist in")) {
        vscode.window.showErrorMessage("This file is not tracked in git or has no commit history yet.");
      } else if (errorMessage.includes("no such path")) {
        vscode.window.showErrorMessage("This file is not tracked in git or has no commit history yet.");
      } else {
        vscode.window.showErrorMessage(`Error: ${errorMessage}`);
      }
    }
  });

  context.subscriptions.push(helloWorldDisposable, lineHistoryDisposable);
}

async function getLineHistory(filePath: string, startLine: number, endLine: number): Promise<CommitInfo[]> {
  try {
    // First check if the file is in a git repository
    try {
      // Use dirname to get the directory containing the file
      const dirPath = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
      
      const { stdout: gitRootOutput } = await execAsync(
        `git -C "${dirPath}" rev-parse --show-toplevel`
      );
      
      if (!gitRootOutput.trim()) {
        throw new Error("Not a git repository");
      }
    } catch (error) {
      throw new Error("The file is not in a git repository");
    }
    
    // Get the commit history for the specified lines
    const { stdout: logOutput } = await execAsync(
      `git log --format="%H|%ad|%an|%s" --date=short -L ${startLine},${endLine}:${filePath}`
    );

    if (!logOutput.trim()) {
      return [];
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
