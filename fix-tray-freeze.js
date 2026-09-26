const fs = require('fs');
const mainPath = 'C:\\Users\\mknig\\blofin-trading-engine\\KnightTrader\\main.js';
let content = fs.readFileSync(mainPath, 'utf8');

// Add window 'show' event handler after the minimize handler
const minimizeHandler = "mainWindow.on('minimize', () => {\n    mainWindow.hide();\n    buildTray();\n  });";

const showHandler = `mainWindow.on('minimize', () => {
    mainWindow.hide();
    buildTray();
  });
  mainWindow.on('show', () => {
    // Force webview resize/redraw after restoring from tray/minimize
    try {
      mainWindow.webContents.send('kt-window-shown');
    } catch (_) {}
  });`;

if (content.includes(minimizeHandler)) {
    content = content.replace(minimizeHandler, showHandler);
    console.log('Added window show handler');
} else {
    console.log('Minimize handler pattern not found, trying direct insertion');
    // Direct insertion approach
    content = content.replace(
        "mainWindow.on('minimize', () => {\n    mainWindow.hide();\n    buildTray();\n  });",
        showHandler
    );
}

// Also improve restoreFromTray to force a focus and show
const restoreMatch = content.indexOf('function restoreFromTray');
if (restoreMatch > 0) {
    const restoreEnd = content.indexOf('function ', restoreMatch + 20);
    if (restoreEnd > 0) {
        const restoreSection = content.substring(restoreMatch, restoreEnd);
        if (restoreSection.includes('refreshTradingWebviewAfterRestore')) {
            // Already has refresh, good
            console.log('restoreFromTray already has refresh');
        }
    }
}

// Also add a focus handler
content = content.replace(
    "mainWindow.on('show', () => {",
    "mainWindow.on('show', () => {\n    mainWindow.focus();"
);

fs.writeFileSync(mainPath, content, 'utf8');
console.log('main.js updated');
