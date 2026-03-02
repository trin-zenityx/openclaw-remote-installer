const Anthropic = require('@anthropic-ai/sdk');

class AIHelper {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = process.env.AI_MODEL || 'claude-sonnet-4-5-20250929';
    this.conversationMessages = [];
  }

  getSystemPrompt(systemInfo) {
    const osInfo = systemInfo.os === 'windows'
      ? `- WSL2 status: ${systemInfo.wsl2Status || 'unknown'}\n- PowerShell version: ${systemInfo.psVersion || 'unknown'}`
      : '';

    return `You are an expert system administrator helping install OpenClaw AI on a remote computer.
You communicate through a remote installation tool. You suggest shell commands one at a time,
and a human teacher reviews and approves each command before it runs on the student's machine.

STUDENT'S SYSTEM INFO:
- OS: ${systemInfo.os}
- Architecture: ${systemInfo.arch}
- Shell: ${systemInfo.shell}
- Node.js version: ${systemInfo.nodeVersion || 'NOT INSTALLED'}
- npm version: ${systemInfo.npmVersion || 'NOT INSTALLED'}
- PATH: ${systemInfo.path}
- Home directory: ${systemInfo.homeDir}
- Current user: ${systemInfo.user}
- Hostname: ${systemInfo.hostname}
${osInfo}

INSTALLATION GOAL:
Install OpenClaw AI (https://openclaw.ai). Steps generally are:
1. Check/install Node.js 22+ (use nvm on macOS/Linux, nvm-windows or direct installer on Windows)
2. For Windows: may need WSL2 setup depending on requirements
3. Run: curl -fsSL https://openclaw.ai/install.sh | bash (or equivalent for Windows/PowerShell)
4. Run: openclaw onboard
5. Verify: openclaw doctor

RULES:
- Suggest ONE command at a time
- Explain what each command does and why (in Thai language for the teacher)
- If a command fails, analyze the error and suggest a fix
- For Windows, determine if WSL2 is needed or if native install works
- Always check PATH issues after installing Node.js
- Be cautious: this runs on a real student's computer
- IMPORTANT: Always respond in JSON format: {"command": "...", "explanation": "...", "isLast": false}
- If you need to check something without running a command, set command to null
- If installation is complete, set isLast to true and include a summary in explanation
- Explanations should be in Thai language`;
  }

  async analyzeAndSuggest(session) {
    const context = session.getContextForAI();

    if (this.conversationMessages.length === 0) {
      this.conversationMessages.push({
        role: 'user',
        content: `Begin OpenClaw installation. The student's system info is already in the system prompt. Please start with diagnostic checks.`
      });
    }

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: this.getSystemPrompt(context.systemInfo),
        messages: this.conversationMessages
      });

      const assistantMessage = response.content[0].text;
      this.conversationMessages.push({
        role: 'assistant',
        content: assistantMessage
      });

      try {
        const jsonMatch = assistantMessage.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (parseErr) {
        // If JSON parsing fails, return raw text as explanation
      }

      return {
        command: null,
        explanation: assistantMessage,
        isLast: false
      };
    } catch (err) {
      throw new Error(`AI API error: ${err.message}`);
    }
  }

  async feedResult(command, stdout, stderr, exitCode) {
    const resultText = [
      `Command executed: ${command}`,
      `Exit code: ${exitCode}`,
      stdout ? `stdout:\n${stdout}` : 'stdout: (empty)',
      stderr ? `stderr:\n${stderr}` : 'stderr: (empty)',
      '',
      'Analyze the result and suggest the next step.'
    ].join('\n');

    this.conversationMessages.push({
      role: 'user',
      content: resultText
    });

    return null; // Next call to analyzeAndSuggest will use this context
  }

  resetConversation() {
    this.conversationMessages = [];
  }
}

module.exports = AIHelper;
