const OPENCLAW_KNOWLEDGE = `
== OpenClaw Installation Knowledge Base ==

OVERVIEW:
OpenClaw is an open-source personal AI assistant platform that runs locally.
Official site: https://openclaw.ai
Documentation: https://docs.openclaw.ai

PREREQUISITES:
- Node.js 22 or higher (REQUIRED)
- npm comes bundled with Node.js
- Internet connection for download
- Admin/sudo access may be needed for global installs

NODE.JS INSTALLATION BY PLATFORM:

macOS/Linux (recommended: nvm):
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # Close and reopen terminal, or run:
  export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  nvm alias default 22

Windows (option A - nvm-windows):
  # Download from https://github.com/coreybutler/nvm-windows/releases
  # Or via winget:
  winget install CoreyButler.NVMforWindows
  # Then in new PowerShell:
  nvm install 22
  nvm use 22

Windows (option B - direct installer):
  # Download from https://nodejs.org (LTS version 22+)
  # Or via winget:
  winget install OpenJS.NodeJS.LTS

OPENCLAW INSTALLATION:

macOS/Linux:
  curl -fsSL https://openclaw.ai/install.sh | bash

Windows (PowerShell):
  irm https://openclaw.ai/install.ps1 | iex

POST-INSTALL SETUP:
  openclaw onboard    # Initial setup, authentication, and configuration
  openclaw doctor     # Verify installation health and check all dependencies

UNINSTALL:
  npm uninstall -g openclaw
  # Then remove config directory:
  # macOS/Linux: rm -rf ~/.openclaw
  # Windows: Remove-Item -Recurse -Force "$env:USERPROFILE\\.openclaw"

COMMON ISSUES AND FIXES:

1. "node: command not found" after nvm install
   - Shell needs to be reloaded: source ~/.bashrc (or ~/.zshrc)
   - Or close and reopen the terminal
   - Check with: echo $PATH | grep nvm
   - If using fish shell: source ~/.config/fish/config.fish

2. "openclaw: command not found" after install
   - PATH may not include the install directory
   - Try: source ~/.bashrc (or ~/.zshrc)
   - Check: which openclaw || ls ~/.local/bin/openclaw
   - Manual PATH fix: export PATH="$HOME/.local/bin:$PATH"
   - On Windows: restart PowerShell session

3. Permission denied errors (macOS/Linux)
   - DO NOT use sudo with nvm
   - If npm global install fails: mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'
   - Add to PATH: export PATH="$HOME/.npm-global/bin:$PATH"

4. Windows execution policy blocks scripts
   - Run: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   - Answer Y when prompted

5. WSL2 considerations (Windows)
   - If WSL2 is installed, OpenClaw can be installed inside WSL2
   - Check WSL2: wsl --status
   - Enter WSL2: wsl
   - Then follow macOS/Linux instructions inside WSL2
   - To install WSL2: wsl --install

6. Node.js version too old
   - Check: node --version (needs v22+)
   - If using nvm: nvm install 22 && nvm use 22 && nvm alias default 22
   - If not using nvm: uninstall old Node.js first, install fresh

7. Network/proxy issues
   - If behind corporate proxy: npm config set proxy http://proxy:port
   - If SSL issues: npm config set strict-ssl false (temporary only)
   - Check connectivity: curl -I https://openclaw.ai

8. openclaw doctor failures
   - Run: openclaw doctor
   - Read each check carefully
   - Common: missing dependencies, wrong Node version, PATH issues
   - Fix each issue one at a time, re-run doctor after each fix

VERIFICATION COMMANDS:
  node --version          # Should be v22.x.x or higher
  npm --version           # Should be 10.x or higher
  which openclaw          # (macOS/Linux) Should show path
  where openclaw          # (Windows) Should show path
  Get-Command openclaw    # (PowerShell) Should show path
  openclaw --version      # Should show version number
  openclaw doctor         # Should pass all checks

USEFUL DIAGNOSTIC COMMANDS:
  echo $PATH              # (macOS/Linux) Check PATH
  echo $env:PATH          # (PowerShell) Check PATH
  npm list -g --depth=0   # List global npm packages
  nvm ls                  # List installed Node versions (if using nvm)
  df -h                   # (macOS/Linux) Check disk space
  Get-PSDrive             # (PowerShell) Check disk space
`;

module.exports = OPENCLAW_KNOWLEDGE;
