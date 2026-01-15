const assert = require('assert');
const vscode = require('vscode');

suite('qqq smoke', () => {
  test('extension can activate', async () => {
    const ext = vscode.extensions.getExtension('gh555.qqq'); // publisher.name
    assert.ok(ext, 'Extension gh555.qqq not found');

    await ext.activate();
    assert.ok(true, 'activated');
  });
});
