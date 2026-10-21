// Integration test: launches VS Code with the extension and runs suite/index.js
//   node test/runTest.js [path/to/code]
const path = require('path');
const { runTests } = require('@vscode/test-electron');

runTests({
	vscodeExecutablePath: process.argv[2] || undefined,
	extensionDevelopmentPath: path.resolve(__dirname, '..'),
	extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
	launchArgs: [path.resolve(__dirname, 'fixtures'), '--disable-extensions', '--skip-welcome'],
}).catch(err => { console.error(err); process.exit(1); });
