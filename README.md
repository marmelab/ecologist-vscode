# EcoLogist status bar extension for VS Code

Shows the estimated environmental impact of your Claude Code session in the VSCode status bar.

This includes greenhouse gas emissions (CO₂), water consumption, and energy consumption are displayed in the status bar, based on the [EcoLogits](https://ecologits.ai/latest/) model and data. 

![Screenshot of the reported impact in the VS Code status bar](./assets/vscode-report.png)

The extension has three modes:

- **Last use**: shows only the last session's impact.
- **Workspace**: shows cumulative impact for all sessions in the current workspace.
- **All time**: shows cumulative impact across all projects and all time.

It's an adaptation of the [ecologits-statusline](https://github.com/DuarteVi/ecologits-statusline) project.

## How to build and run the extension

1. Install dependencies:

```bash
npm install
```

2. Compile the extension:

```bash
npm run compile
```

3. Package the extension:

```bash
npm run package
```

It will generate a `.vsix` file in the root folder. You can install it in VS Code by opening the command palette (Ctrl+Shift+P), typing "Extensions: Install from VSIX...", and selecting the generated `.vsix` file.
