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

// Class for providing line history completions
class GitHistoryCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    try {
      // Only provide completions when explicitly triggered
      if (context.triggerKind !== vscode.CompletionTriggerKind.Invoke) {
        return undefined;
      }
      
      // Get line history for the current line
      const filePath = document.uri.fsPath;
      const lineNumber = position.line + 1; // Convert to 1-based
      
      // Show a loading indicator
      vscode.window.setStatusBarMessage('Loading line history...', 2000);
      
      // Get git root path
      const gitRootPath = await getGitRootPath(filePath);
      const relativeFilePath = path.relative(gitRootPath, filePath);
      
      // Get commit hashes from git blame
      const blameCommand = `git -C "${gitRootPath}" blame -L ${lineNumber},${lineNumber} "${relativeFilePath}" --porcelain`;
      log(`Executing git blame command: ${blameCommand}`);
      
      const { stdout: blameOutput } = await execAsync(blameCommand);
      if (!blameOutput.trim()) {
        return undefined;
      }
      
      // Parse blame output to get commit hashes
      const commitHashes = new Set<string>();
      const blameLines = blameOutput.split('\n');
      
      for (let i = 0; i < blameLines.length; i++) {
        const line = blameLines[i];
        if (line.match(/^[0-9a-f]{40}\s/)) {
          const hash = line.split(' ')[0];
          if (hash !== '0000000000000000000000000000000000000000') {
            commitHashes.add(hash);
          }
        }
      }
      
      if (commitHashes.size === 0) {
        return undefined;
      }
      
      // Create completion items for each commit
      const completionItems: vscode.CompletionItem[] = [];
      
      for (const hash of commitHashes) {
        // Get commit details
        const { stdout: commitDetails } = await execAsync(
          `git -C "${gitRootPath}" show --format="%H|%ad|%an|%s" --date=short ${hash} -s`,
          { encoding: 'utf8' }
        );
        
        const [commitHash, date, author, message] = commitDetails.trim().split('|');
        
        // Get the file content at this commit
        const content = await getFileStateAtCommit(gitRootPath, relativeFilePath, hash, lineNumber, lineNumber);
        
        // Extract just the line content without the line number prefix
        const lineContent = content.replace(/^\d+:\s/, '');
        
        // Create completion item
        const item = new vscode.CompletionItem(
          `${date} - ${message} (${commitHash.substring(0, 7)})`,
          vscode.CompletionItemKind.Text
        );
        
        item.insertText = lineContent;
        item.detail = `${author} - ${date}`;
        item.documentation = new vscode.MarkdownString(
          `**Commit:** ${commitHash.substring(0, 7)}\n` +
          `**Author:** ${author}\n` +
          `**Date:** ${date}\n` +
          `**Message:** ${message}\n\n` +
          `\`\`\`\n${content}\n\`\`\``
        );
        
        completionItems.push(item);
      }
      
      return completionItems;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Error providing completions: ${errorMessage}`);
      return undefined;
    }
  }
}

// Class for providing inline completions
class GitHistoryInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    try {
      // Get line history for the current line
      const filePath = document.uri.fsPath;
      const lineNumber = position.line + 1; // Convert to 1-based
      
      // Get git root path
      const gitRootPath = await getGitRootPath(filePath);
      const relativeFilePath = path.relative(gitRootPath, filePath);
      
      // Get commit hashes from git blame
      const blameCommand = `git -C "${gitRootPath}" blame -L ${lineNumber},${lineNumber} "${relativeFilePath}" --porcelain`;
      
      const { stdout: blameOutput } = await execAsync(blameCommand);
      if (!blameOutput.trim()) {
        return undefined;
      }
      
      // Parse blame output to get commit hashes
      const commitHashes = new Set<string>();
      const blameLines = blameOutput.split('\n');
      
      for (let i = 0; i < blameLines.length; i++) {
        const line = blameLines[i];
        if (line.match(/^[0-9a-f]{40}\s/)) {
          const hash = line.split(' ')[0];
          if (hash !== '0000000000000000000000000000000000000000') {
            commitHashes.add(hash);
          }
        }
      }
      
      if (commitHashes.size === 0) {
        return undefined;
      }
      
      // Create inline completion items for each commit
      const inlineCompletionItems: vscode.InlineCompletionItem[] = [];
      
      for (const hash of commitHashes) {
        // Get commit details
        const { stdout: commitDetails } = await execAsync(
          `git -C "${gitRootPath}" show --format="%H|%ad|%an|%s" --date=short ${hash} -s`,
          { encoding: 'utf8' }
        );
        
        const [commitHash, date, author, message] = commitDetails.trim().split('|');
        
        // Get the file content at this commit
        const content = await getFileStateAtCommit(gitRootPath, relativeFilePath, hash, lineNumber, lineNumber);
        
        // Extract just the line content without the line number prefix
        const lineContent = content.replace(/^\d+:\s/, '');
        
        // Create inline completion item
        const item = new vscode.InlineCompletionItem(
          lineContent,
          new vscode.Range(position.line, 0, position.line, document.lineAt(position.line).text.length)
        );
        
        item.command = {
          title: 'Show Commit Details',
          command: 'codehistory.showCommitDetails',
          arguments: [commitHash, date, author, message]
        };
        
        inlineCompletionItems.push(item);
      }
      
      return {
        items: inlineCompletionItems,
        suppressSuggestionDetails: false
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Error providing inline completions: ${errorMessage}`);
      return undefined;
    }
  }
}

// Helper function to get the git root path
async function getGitRootPath(filePath: string): Promise<string> {
  try {
    const fileDir = path.dirname(filePath);
    const { stdout } = await execAsync(`git -C "${fileDir}" rev-parse --show-toplevel`);
    return stdout.trim();
  } catch (error) {
    // Fallback to manual .git directory detection
    let currentDir = path.dirname(filePath);
    
    while (currentDir !== path.parse(currentDir).root) {
      const gitDirPath = path.join(currentDir, '.git');
      
      if (fs.existsSync(gitDirPath)) {
        return currentDir;
      }
      
      currentDir = path.dirname(currentDir);
    }
    
    throw new Error("Not a git repository");
  }
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

  // Register the completion providers
  const completionProvider = new GitHistoryCompletionProvider();
  const completionRegistration = vscode.languages.registerCompletionItemProvider(
    { scheme: 'file' },
    completionProvider
  );
  context.subscriptions.push(completionRegistration);
  
  // Register the inline completion provider
  const inlineCompletionProvider = new GitHistoryInlineCompletionProvider();
  const inlineCompletionRegistration = vscode.languages.registerInlineCompletionItemProvider(
    { scheme: 'file' },
    inlineCompletionProvider
  );
  context.subscriptions.push(inlineCompletionRegistration);
  
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

  // Register command to show commit details
  const showCommitDetailsDisposable = vscode.commands.registerCommand(
    'codehistory.showCommitDetails',
    (hash: string, date: string, author: string, message: string) => {
      vscode.window.showInformationMessage(
        `Commit: ${hash.substring(0, 7)} | ${date} | ${author} | ${message}`
      );
    }
  );
  
  // Register command to show line history as completions
  const showHistoryAsCompletionsDisposable = vscode.commands.registerCommand(
    'codehistory.showHistoryAsCompletions',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
      }
      
      // Trigger the completion provider
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
  );
  
  // Register command to show line history as inline completions
  const showHistoryAsInlineCompletionsDisposable = vscode.commands.registerCommand(
    'codehistory.showHistoryAsInlineCompletions',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
      }
      
      // Trigger the inline completion provider
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }
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
    lineHistoryDisposable,
    showHistoryAsCompletionsDisposable,
    showHistoryAsInlineCompletionsDisposable,
    showCommitDetailsDisposable
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
    
    // Get user preference for showing diff or state
    const config = vscode.workspace.getConfiguration('codehistory');
    const showDiff = config.get<boolean>('showDiff', false);
    log(`Show diff mode: ${showDiff}`);
    
    // Step 1: Get commit hashes from git blame for the selected lines
    const blameCommand = `git -C "${gitRootPath}" blame -L ${startLine},${endLine} "${relativeFilePath}" --porcelain`;
    log(`Executing git blame command: ${blameCommand}`);
    
    const { stdout: blameOutput } = await execAsync(blameCommand);
    if (!blameOutput.trim()) {
      log('Git blame command returned empty output');
      return [];
    }
    
    // Parse blame output to get commit hashes
    const commitHashes = new Set<string>();
    const blameLines = blameOutput.split('\n');
    
    for (let i = 0; i < blameLines.length; i++) {
      const line = blameLines[i];
      if (line.match(/^[0-9a-f]{40}\s/)) {
        const hash = line.split(' ')[0];
        if (hash !== '0000000000000000000000000000000000000000') {
          commitHashes.add(hash);
        }
      }
    }
    
    log(`Found ${commitHashes.size} unique commits affecting the selected lines`);
    
    const commits: CommitInfo[] = [];
    
    // Step 2: Get basic details for each commit (without content)
    for (const hash of commitHashes) {
      try {
        // Get commit details
        const { stdout: commitDetails } = await execAsync(
          `git -C "${gitRootPath}" show --format="%H|%ad|%an|%s" --date=short ${hash} -s`,
          { encoding: 'utf8' }
        );
        
        const [commitHash, date, author, message] = commitDetails.trim().split('|');
        
        // Add commit to the list without content
        commits.push({
          hash: commitHash,
          date,
          author,
          message,
          content: '' // Content will be loaded on demand
        });
      } catch (error) {
        log(`Error processing commit ${hash}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Sort commits by date (newest first)
    commits.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateB.getTime() - dateA.getTime();
    });
    
    return commits;
  } catch (error) {
    console.error('Error getting line history:', error);
    throw new Error(`Failed to get line history: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Helper function to get the state of a file at a specific commit
async function getFileStateAtCommit(
  gitRootPath: string,
  relativeFilePath: string,
  commitHash: string,
  startLine: number,
  endLine: number
): Promise<string> {
  try {
    // Get the file content at this commit
    const { stdout: fileContent } = await execAsync(
      `git -C "${gitRootPath}" show ${commitHash}:${relativeFilePath}`,
      { encoding: 'utf8' }
    );
    
    // Extract just the lines we're interested in
    const lines = fileContent.split('\n');
    
    // Make sure we don't go out of bounds
    const actualStartLine = Math.max(0, startLine - 1);
    const actualEndLine = Math.min(lines.length, endLine);
    
    if (actualStartLine >= lines.length || actualEndLine <= 0 || actualStartLine >= actualEndLine) {
      return `// Lines ${startLine}-${endLine} did not exist in this version of the file`;
    }
    
    // Add line numbers to make it easier to follow
    const selectedLines = lines.slice(actualStartLine, actualEndLine).map((line, idx) => {
      const lineNum = actualStartLine + idx + 1;
      return `${lineNum}: ${line}`;
    });
    
    return selectedLines.join('\n');
  } catch (error) {
    log(`Error getting file state: ${error instanceof Error ? error.message : String(error)}`);
    return `// File did not exist at this commit or lines were outside the file's content`;
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
    
    private _loadingContent = false;
    
    async loadCommitContent(index: number): Promise<void> {
      if (this._loadingContent) return;
      
      const commit = commits[index];
      if (commit.content.trim() !== '') return; // Content already loaded
      
      this._loadingContent = true;
      
      try {
        const config = vscode.workspace.getConfiguration('codehistory');
        const showDiff = config.get<boolean>('showDiff', false);
        
        // Get the git root directory
        const { stdout: gitRootOutput } = await execAsync(`git -C "${path.dirname(document.uri.fsPath)}" rev-parse --show-toplevel`);
        const gitRootPath = gitRootOutput.trim();
        
        // Get the relative path to the file from the git root
        const relativeFilePath = path.relative(gitRootPath, document.uri.fsPath);
        
        if (showDiff) {
          // Get the diff for this commit, limited to the selected lines
          try {
            // First, get the parent commit
            const { stdout: parentOutput } = await execAsync(
              `git -C "${gitRootPath}" rev-parse ${commit.hash}^`,
              { encoding: 'utf8' }
            );
            const parentHash = parentOutput.trim();
            
            // Use git show with -U option to show the diff with context
            const diffCommand = `git -C "${gitRootPath}" show --unified=5 ${commit.hash} -- "${relativeFilePath}"`;
            log(`Executing diff command: ${diffCommand}`);
            
            try {
              const { stdout: diffOutput } = await execAsync(diffCommand);
              
              // Process the diff output to extract just the relevant lines
              const diffLines = diffOutput.split('\n');
              
              // Find the diff hunks that include our lines of interest
              let inHunk = false;
              let hunkStartLine = 0;
              let relevantLines: string[] = [];
              
              for (const line of diffLines) {
                // Look for diff header lines
                if (line.startsWith('@@')) {
                  // Parse the hunk header to get line numbers
                  const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                  if (match) {
                    hunkStartLine = parseInt(match[1], 10);
                    inHunk = true;
                    relevantLines.push(line);
                  } else {
                    inHunk = false;
                  }
                } 
                // If we're in a hunk, check if it contains our lines of interest
                else if (inHunk) {
                  // Include the line if it's part of the diff
                  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                    // Calculate the current line number in the new file
                    if (line.startsWith('+')) {
                      // This is a line in the new file
                      const currentLine = hunkStartLine++;
                      // Check if this line is in our range of interest
                      if (currentLine >= startLine + 1 && currentLine <= endLine + 1) {
                        relevantLines.push(line);
                      }
                    } else if (line.startsWith(' ')) {
                      // This is a context line that exists in both files
                      const currentLine = hunkStartLine++;
                      // Check if this line is in our range of interest
                      if (currentLine >= startLine + 1 && currentLine <= endLine + 1) {
                        relevantLines.push(line);
                      }
                    } else if (line.startsWith('-')) {
                      // This is a line that was removed, always include it
                      relevantLines.push(line);
                    }
                  } else {
                    // End of hunk
                    inHunk = false;
                  }
                }
              }
              
              commit.content = relevantLines.join('\n');
              
              // If we didn't find any relevant lines in the diff, fall back to showing the state
              if (!commit.content.trim()) {
                log('No relevant changes found in diff, falling back to file state');
                commit.content = await getFileStateAtCommit(gitRootPath, relativeFilePath, commit.hash, startLine + 1, endLine + 1);
              }
            } catch (diffError) {
              log(`Error getting diff: ${diffError instanceof Error ? diffError.message : String(diffError)}`);
              // If diff fails, fall back to showing the state
              commit.content = await getFileStateAtCommit(gitRootPath, relativeFilePath, commit.hash, startLine + 1, endLine + 1);
            }
          } catch (parentError) {
            log(`Error getting parent commit: ${parentError instanceof Error ? parentError.message : String(parentError)}`);
            // If getting parent fails (e.g., for first commit), fall back to showing the state
            commit.content = await getFileStateAtCommit(gitRootPath, relativeFilePath, commit.hash, startLine + 1, endLine + 1);
          }
        } else {
          // Get the state of the file at this commit
          commit.content = await getFileStateAtCommit(gitRootPath, relativeFilePath, commit.hash, startLine + 1, endLine + 1);
        }
        
        // Trigger update of the view
        this._onDidChange.fire(this._uri);
      } catch (error) {
        log(`Error loading commit content: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this._loadingContent = false;
      }
    }
    
    provideTextDocumentContent(_uri: vscode.Uri): string {
      const commit = commits[this._currentCommitIndex];
      const config = vscode.workspace.getConfiguration('codehistory');
      const showDiff = config.get<boolean>('showDiff', false);
      
      // Load content if not already loaded
      if (!commit.content || commit.content.trim() === '') {
        // Start loading content asynchronously
        this.loadCommitContent(this._currentCommitIndex);
        
        // Format the header
        const header = [
          `// Commit: ${commit.hash.substring(0, 7)} (${this._currentCommitIndex + 1}/${commits.length})`,
          `// Author: ${commit.author}`,
          `// Date: ${commit.date}`,
          `// Message: ${commit.message}`,
          `// Mode: ${showDiff ? 'Showing diff' : 'Showing state at commit'}`,
          `// Use 'Next Commit' and 'Previous Commit' buttons to navigate`,
          '',
          '// Loading content...'
        ].join('\n');
        
        return header;
      }
      
      // Format the content with commit info at the top
      const header = [
        `// Commit: ${commit.hash.substring(0, 7)} (${this._currentCommitIndex + 1}/${commits.length})`,
        `// Author: ${commit.author}`,
        `// Date: ${commit.date}`,
        `// Message: ${commit.message}`,
        `// Mode: ${showDiff ? 'Showing diff' : 'Showing state at commit'}`,
        `// Use 'Next Commit' and 'Previous Commit' buttons to navigate`,
        ''
      ].join('\n');
      
      // Check if content is empty or just whitespace
      if (!commit.content || commit.content.trim() === '') {
        if (showDiff) {
          return header + '// No changes to these lines in this commit\n// Try switching to "Showing State" mode to see the content';
        } else {
          return header + '// These lines did not exist in this version of the file';
        }
      }
      
      return header + commit.content;
    }
  }(vscode.Uri.parse(`git-history:${document.uri.fsPath}`));
  
  // Register the provider
  const registration = vscode.workspace.registerTextDocumentContentProvider('git-history', historyProvider);
  
  // Create the URI for our virtual document
  const uri = vscode.Uri.parse(`git-history:${document.uri.fsPath}`);
  
  // Get the command manager
  const commandManager = CommandManager.getInstance();
  
  // Register commands for navigating between commits
  const nextDisposable = await commandManager.registerCommand('codehistory.nextCommit', async () => {
    if (historyProvider.currentCommitIndex < commits.length - 1) {
      historyProvider.currentCommitIndex++;
      // Preload the next commit's content if it's not already loaded
      await historyProvider.loadCommitContent(historyProvider.currentCommitIndex);
    }
  });
  
  const prevDisposable = await commandManager.registerCommand('codehistory.prevCommit', async () => {
    if (historyProvider.currentCommitIndex > 0) {
      historyProvider.currentCommitIndex--;
      // Preload the previous commit's content if it's not already loaded
      await historyProvider.loadCommitContent(historyProvider.currentCommitIndex);
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
  
  // Add toggle button for diff/state view
  const toggleButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  const config = vscode.workspace.getConfiguration('codehistory');
  const showDiff = config.get<boolean>('showDiff', false);
  toggleButton.text = showDiff ? "$(diff) Showing Diff" : "$(file) Showing State";
  toggleButton.command = 'codehistory.toggleViewMode';
  toggleButton.tooltip = 'Toggle between diff and state view';
  toggleButton.show();
  
  // Register toggle command
  const toggleDisposable = await commandManager.registerCommand('codehistory.toggleViewMode', async () => {
    const config = vscode.workspace.getConfiguration('codehistory');
    const currentMode = config.get<boolean>('showDiff', false);
    await config.update('showDiff', !currentMode, vscode.ConfigurationTarget.Global);
    
    try {
      // Clear content for all commits to force reload with new mode
      commits.forEach(commit => {
        commit.content = '';
      });
      
      // Load content for current commit
      await historyProvider.loadCommitContent(historyProvider.currentCommitIndex);
      
      // Update button text
      toggleButton.text = !currentMode ? "$(diff) Showing Diff" : "$(file) Showing State";
    } catch (error) {
      log(`Error refreshing view: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`Error refreshing view: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  
  // Load content for the first commit
  await historyProvider.loadCommitContent(0);
  
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
      toggleDisposable.dispose();
      nextButton.dispose();
      prevButton.dispose();
      toggleButton.dispose();
      disposable.dispose();
      
      // Unregister the commands
      const commandManager = CommandManager.getInstance();
      commandManager.unregisterCommand('codehistory.nextCommit');
      commandManager.unregisterCommand('codehistory.prevCommit');
      commandManager.unregisterCommand('codehistory.toggleViewMode');
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
