// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { CodeHistoryItem, CodeHistoryCompletion } from './types'
import { start } from 'repl'

const execAsync = promisify(exec)

// Create an output channel for logging
const outputChannel = vscode.window.createOutputChannel('Code History')

// Command manager to handle registration/unregistration
class CommandManager {
  private static instance: CommandManager
  private registeredCommands: Map<string, vscode.Disposable> = new Map()
  
  private constructor() {}
  
  public static getInstance(): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager()
    }
    return CommandManager.instance
  }
  
  public async registerCommand(id: string, callback: (...args: any[]) => any): Promise<vscode.Disposable> {
    // Unregister existing command if it exists
    await this.unregisterCommand(id)
    
    // Register the new command
    const disposable = vscode.commands.registerCommand(id, callback)
    this.registeredCommands.set(id, disposable)
    return disposable
  }
  
  public async unregisterCommand(id: string): Promise<void> {
    const disposable = this.registeredCommands.get(id)
    if (disposable) {
      disposable.dispose()
      this.registeredCommands.delete(id)
    }
  }
}

function log(message: string): void {
  console.log(message)
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`)
}

// Class for providing line history completions
let myCompletionSessionActive = false
function setCompletionSessionActive() {
  myCompletionSessionActive = true
  setTimeout(() => {
    myCompletionSessionActive = false
  }, 200)
}
let activeCompletionIndex: number | null = null
let activeCompletions: { insertText: string; range: vscode.Range }[] = []

async function completions(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<CodeHistoryCompletion[]> {
  if (!myCompletionSessionActive) {
    return []
  }

  try {
    // Parse the log output to extract commits and their line content
    const data = await codeHistoryAtSelection()

    const commits = data?.items || []

    if (!data || commits.length === 0) {
      return []
    }
    
    // Create completion items for each commit
    const completionItems: CodeHistoryCompletion[] = []
    
    for (const commit of commits) {
      // Skip commits where we couldn't extract the line content
      if (!commit.content) continue
      
      const language = detectMarkdownCodeLanguage(data.document.uri)

      // Set the text that will be inserted when selected
      // Create a snippet that replaces the entire line
      const lineText = data.document.lineAt(data.startLine).text
    
      const item: CodeHistoryCompletion = {
        label: `${commit.date}, ${commit.author}`,
        description: commit.message,
        documentation: new vscode.MarkdownString(`\`\`\`${language}\n${commit.content.trim()}\n\`\`\``),
        range: new vscode.Range(
          data.startLine, 0,
          data.endLine, lineText.length
        ),
        insertText: commit.content,
        detail: commit.message,
        filterText: data.document.getText(new vscode.Range(
          data.startLine,
          0,
          data.startLine,
          Math.min(data.document.lineAt(data.startLine).text.length, 10)
        )),
        sortText: (99999999999 - commit.timestamp).toString().padStart(15, '0')
      }
    
      completionItems.push(item)
    }
    
    // Always return an array, even if empty
    return completionItems
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log(`Error providing completions: ${errorMessage}`)
    return []
  }
}

async function codeHistoryAtSelection(): Promise<{items: CodeHistoryItem[], document: vscode.TextDocument, startLine: number, endLine: number} | undefined> {
  // Show the output channel
  outputChannel.clear()
  log('Command: showLineHistory started')
  
  // First check if git is installed
  try {
    const { stdout: gitVersion } = await execAsync('git --version')
    log(`Git version: ${gitVersion.trim()}`)
  } catch (error) {
    const errorMsg = `Git is not installed or not available in PATH: ${error instanceof Error ? error.message : String(error)}`
    log(errorMsg)
    vscode.window.showErrorMessage('Git is not installed or not available in PATH. Please install Git to use this extension.')
    return 
  }
  
  // Handle both invocation methods (from context menu or from CodeLens)
  let startLine: number
  let endLine: number
  
 // Called from context menu
 const editor = vscode.window.activeTextEditor
 if (!editor) {
   vscode.window.showErrorMessage('No active editor found')
   return
 }

 const document = editor.document
 
 // Check if the document is saved
 if (document.isDirty) {
   vscode.window.showWarningMessage('Please save the file before viewing its history')
   return
 }
 
 const selection = editor.selection
 
 // If selection is empty, use the current cursor line
 if (selection.isEmpty) {
   startLine = selection.active.line // Git uses 1-based line numbers
   endLine = startLine
 } else {
   startLine = selection.start.line
   endLine = selection.end.line
 }

 return {
    items: await codeHistory(document, startLine, endLine),
    document,
    startLine,
    endLine
 }
}

async function codeHistory(
  document: vscode.TextDocument,
  startLine: number,
  endLine: number
): Promise<CodeHistoryItem[]> {
  try {
    // Get line history for the current line
    const filePath = document.uri.fsPath
    
    // Show a loading indicator
    vscode.window.setStatusBarMessage('Loading line history...', 2000)
    
    // Get git root path
    const gitRootPath = await getGitRootPath(filePath)
    const relativeFilePath = path.relative(gitRootPath, filePath)
    
    // Get commit history with content using git log
    // This command gets the commits and shows the actual content of each version of the line
    const logCommand = `git -C "${gitRootPath}" log -p --format="%H|%ad|%an|%s" --date=unix -L ${startLine + 1},${endLine + 1}:"${relativeFilePath}"`
    log(`Executing git log command: ${logCommand}`)
    
    const { stdout: logOutput } = await execAsync(logCommand)
    if (!logOutput.trim()) {
      return []
    }
    
    // Parse the log output to extract commits and their line content
    const commits: Array<CodeHistoryItem> = []
    const logLines = logOutput.split('\n')
    
    let currentCommit: CodeHistoryItem | null = null
    let inHunk = false
    
    for (let i = 0; i < logLines.length; i++) {
      const line = logLines[i].trim()
      
      // Check for commit header line
      if (line.includes('|') && line.match(/^[0-9a-f]{40}\|/)) {
        const [hash, date, author, ...messageParts] = line.split('|')
        const message = messageParts.join('|') // Rejoin message parts in case it contained |
        
        currentCommit = {
          hash,
          date: new Date(parseInt(date, 10) * 1000).toISOString().split('T')[0], // Convert to ISO date
          timestamp: parseInt(date, 10),
          author,
          message,
          content: '',
          range: new vscode.Range(
            startLine, 0,
            endLine, document.lineAt(endLine).text.length
          )
        }
        
        commits.push(currentCommit)
        inHunk = false
      }
      // Look for the hunk header for our line
      else if (line.startsWith('@@') && currentCommit) {
        inHunk = true
      }
      // If we're in a hunk and find a + line, it's the content we want
      else if (inHunk && line.startsWith('+') && currentCommit) {
        // Remove the + prefix to get the actual line content
        currentCommit.content = line.substring(1)
        inHunk = false // We found what we needed
      }
    }
    return commits
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log(`Error providing commits: ${errorMessage}`)
    return []
  }
}

function detectMarkdownCodeLanguage(uri: vscode.Uri): string {
  const ext = path.extname(uri.fsPath).toLowerCase()
  switch (ext) {
    case '.js':
    case '.jsx':
      return 'javascript'
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.py':
      return 'python'
    case '.cpp':
      return 'c'
    case '.html':
    case '.htm':
      return 'html'
    case '.clj':
    case '.cljs':
    case '.cljd':
    case '.cljc':
      return 'clojure'
    case '.rb':
      return 'ruby'
    default:
      return ext.substring(1) // Use the file extension as the language
  }
}

class GitHistoryCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    return completions(document, position).then(completionItems => {
    
      const items = completionItems.map(item => {
        const completionItem = new vscode.CompletionItem(item.label, vscode.CompletionItemKind.Text)
        completionItem.detail = item.detail
        completionItem.documentation = item.documentation
        completionItem.insertText = item.insertText
        completionItem.range = item.range
        completionItem.sortText = item.sortText
        completionItem.filterText = item.filterText
        
        // Add a command to show commit details when selected
        completionItem.command = {
          title: 'Show commit details',
          command: 'codehistory.showCommitDetails',
          arguments: [item.label, item.detail, item.documentation]
        }
        
        return completionItem
      })
      return items
    })
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
    return completions(document, position).then(completionItems => {
      if (!completionItems) return
    
      const items = completionItems.map(item => {
        const insertText = typeof item.insertText === 'string' ? item.insertText : item.label.toString()

        const inlineItem = new vscode.InlineCompletionItem(insertText)
        inlineItem.range = item.range
        inlineItem.command = {
          title: 'Show commit details',
          command: 'codehistory.showCommitDetails',
          arguments: [insertText, item.detail, item.documentation]
        }
        return inlineItem
      })
      
      return new vscode.InlineCompletionList(items)
    })
  }
}

// Helper function to get the git root path
async function getGitRootPath(filePath: string): Promise<string> {
  try {
    const fileDir = path.dirname(filePath)
    const { stdout } = await execAsync(`git -C "${fileDir}" rev-parse --show-toplevel`)
    return stdout.trim()
  } catch (error) {
    // Fallback to manual .git directory detection
    let currentDir = path.dirname(filePath)
    
    while (currentDir !== path.parse(currentDir).root) {
      const gitDirPath = path.join(currentDir, '.git')
      
      if (fs.existsSync(gitDirPath)) {
        return currentDir
      }
      
      currentDir = path.dirname(currentDir)
    }
    
    throw new Error("Not a git repository")
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Register the completion providers
  const completionProvider = new GitHistoryCompletionProvider()
  const completionRegistration = vscode.languages.registerCompletionItemProvider(
    { scheme: 'file' },
    completionProvider,
    // Add trigger characters to make it easier to invoke
    'ƛ'
  )
  context.subscriptions.push(completionRegistration)
  
  // Register the inline completion provider
  const inlineCompletionProvider = new GitHistoryInlineCompletionProvider()
  const inlineCompletionRegistration = vscode.languages.registerInlineCompletionItemProvider(
    { scheme: 'file' },
    inlineCompletionProvider
  )
  context.subscriptions.push(inlineCompletionRegistration)

  // Register command to show commit details
  const showCommitDetailsDisposable = vscode.commands.registerCommand(
    'codehistory.showCommitDetails',
    (hash: string, date: string, author: string, message: string) => {
      vscode.window.showInformationMessage(
        `Commit: ${hash.substring(0, 7)} | ${date} | ${author} | ${message}`
      )
    }
  )
  
  // Register command to show line history as completions
  const showHistoryAsCompletionsDisposable = vscode.commands.registerCommand(
    'codehistory.showHistoryAsCompletions',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found')
        return
      }
      
      // Show a loading indicator
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Loading line history...",
        cancellable: false
      }, async (progress) => {
        try {
          setCompletionSessionActive()
          await vscode.commands.executeCommand('editor.action.triggerSuggest')
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(`Error showing completions: ${errorMessage}`)
        }
      })
    }
  )
  
  // Register command to show line history as inline completions
  const showHistoryAsInlineCompletionsDisposable = vscode.commands.registerCommand(
    'codehistory.showHistoryAsInlineCompletions',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found')
        return
      }
      // Trigger the inline completion provider
      setCompletionSessionActive()
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
    }
  )
  
  // Register the command that will show history in a peek view
  const lineHistoryDisposable = vscode.commands.registerCommand('codehistory.showLineHistory', async () => {
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Loading code history...",
      cancellable: false
    }, async (progress) => {
      const data = await codeHistoryAtSelection()
  
      if (!data || data.items.length === 0) {
        vscode.window.showInformationMessage('No history found for the selected lines')
      } else {
        await showHistoryInPeekView(
          data.document,
          data.startLine,
          data.items
        )
      }
    })
  })

  context.subscriptions.push(
    lineHistoryDisposable,
    showHistoryAsCompletionsDisposable,
    showHistoryAsInlineCompletionsDisposable,
    showCommitDetailsDisposable
    // Don't register nextCommit and prevCommit here - they're registered dynamically when needed
  )
}

// Function to show history in a peek view
async function showHistoryInPeekView(
  document: vscode.TextDocument,
  startLine: number,
  commits: CodeHistoryItem[]
): Promise<void> {
  // Create a virtual document provider for showing history
  const historyProvider = new class implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>()
    public readonly onDidChange = this._onDidChange.event
    
    private _currentCommitIndex = 0
    
    public get currentCommitIndex(): number {
      return this._currentCommitIndex
    }
    
    public set currentCommitIndex(value: number) {
      this._currentCommitIndex = value
      this._onDidChange.fire(this._uri)
    }
    
    private _uri: vscode.Uri
    
    constructor(uri: vscode.Uri) {
      this._uri = uri
    }
    
    provideTextDocumentContent(_uri: vscode.Uri): string {
      const commit = commits[this._currentCommitIndex]
      const config = vscode.workspace.getConfiguration('codehistory')
      const showDiff = config.get<boolean>('showDiff', false)
    
      // Format the content with commit info at the top
      const header = [
        `// Commit: ${commit.hash.substring(0, 7)} (${this._currentCommitIndex + 1}/${commits.length})`,
        `// Author: ${commit.author}`,
        `// Date: ${commit.date}`,
        `// Message: ${commit.message}`,
        `// Mode: ${showDiff ? 'Showing diff' : 'Showing state at commit'}`,
        `// Use 'Next Commit' and 'Previous Commit' buttons to navigate`,
        ''
      ].join('\n')
      
      // Check if content is empty or just whitespace
      if (!commit.content || commit.content.trim() === '') {
        if (showDiff) {
          return header + '// No changes to these lines in this commit\n// Try switching to "Showing State" mode to see the content'
        } else {
          return header + '// These lines did not exist in this version of the file'
        }
      }
      
      return header + commit.content
    }
  }(vscode.Uri.parse(`git-history:${document.uri.fsPath}`))
  
  // Register the provider
  const registration = vscode.workspace.registerTextDocumentContentProvider('git-history', historyProvider)
  
  // Create the URI for our virtual document
  const uri = vscode.Uri.parse(`git-history:${document.uri.fsPath}`)
  
  // Get the command manager
  const commandManager = CommandManager.getInstance()
  
  // Register commands for navigating between commits
  const nextDisposable = await commandManager.registerCommand('codehistory.nextCommit', async () => {
    if (historyProvider.currentCommitIndex < commits.length - 1) {
      historyProvider.currentCommitIndex++
    }
  })
  
  const prevDisposable = await commandManager.registerCommand('codehistory.prevCommit', async () => {
    if (historyProvider.currentCommitIndex > 0) {
      historyProvider.currentCommitIndex--
    }
  })
  
  // Add navigation buttons to the editor toolbar
  const nextButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  nextButton.text = "$(arrow-right) Next Commit"
  nextButton.command = 'codehistory.nextCommit'
  nextButton.tooltip = 'Show next commit'
  nextButton.show()
  
  const prevButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101)
  prevButton.text = "$(arrow-left) Previous Commit"
  prevButton.command = 'codehistory.prevCommit'
  prevButton.tooltip = 'Show previous commit'
  prevButton.show()
  
  // Add toggle button for diff/state view
  const toggleButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  const config = vscode.workspace.getConfiguration('codehistory')
  const showDiff = config.get<boolean>('showDiff', false)
  toggleButton.text = showDiff ? "$(diff) Showing Diff" : "$(file) Showing State"
  toggleButton.command = 'codehistory.toggleViewMode'
  toggleButton.tooltip = 'Toggle between diff and state view'
  toggleButton.show()
  
  // Register toggle command
  const toggleDisposable = await commandManager.registerCommand('codehistory.toggleViewMode', async () => {
    const config = vscode.workspace.getConfiguration('codehistory')
    const currentMode = config.get<boolean>('showDiff', false)
    await config.update('showDiff', !currentMode, vscode.ConfigurationTarget.Global)
    
    try {
      // Clear content for all commits to force reload with new mode
      commits.forEach(commit => {
        commit.content = ''
      })
      
      // Update button text
      toggleButton.text = !currentMode ? "$(diff) Showing Diff" : "$(file) Showing State"
    } catch (error) {
      log(`Error refreshing view: ${error instanceof Error ? error.message : String(error)}`)
      vscode.window.showErrorMessage(`Error refreshing view: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  
  // Show the peek view
  await vscode.commands.executeCommand('editor.action.showReferences',
    document.uri,
    // Position at the start of the selected range
    new vscode.Position(startLine, 0),
    // Create a location that points to our virtual document
    [new vscode.Location(uri, new vscode.Position(0, 0))]
  )
  
  // Clean up when the peek view is closed
  const disposable = vscode.window.onDidChangeVisibleTextEditors(() => {
    const isHistoryOpen = vscode.window.visibleTextEditors.some(
      editor => editor.document.uri.scheme === 'git-history'
    )
    
    if (!isHistoryOpen) {
      log('History view closed, cleaning up resources')
      registration.dispose()
      nextDisposable.dispose()
      prevDisposable.dispose()
      toggleDisposable.dispose()
      nextButton.dispose()
      prevButton.dispose()
      toggleButton.dispose()
      disposable.dispose()
      
      // Unregister the commands
      const commandManager = CommandManager.getInstance()
      commandManager.unregisterCommand('codehistory.nextCommit')
      commandManager.unregisterCommand('codehistory.prevCommit')
      commandManager.unregisterCommand('codehistory.toggleViewMode')
    }
  })
}

// This method is called when your extension is deactivated
export function deactivate() {}
