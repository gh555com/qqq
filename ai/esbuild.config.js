const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
    console.log('qqq-ai: building...');

    if (!fs.existsSync('dist')) fs.mkdirSync('dist');

    await esbuild.build({
        entryPoints: ['./src/extension.js'],
        bundle: true,
        outfile: './dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        minify: true,
        sourcemap: false,
        legalComments: 'none',
        loader: { '.html': 'text' }
    });

    // ━━━ 组装 chat.html：模板 + CSS + JS 内联为单文件 ━━━
    const chatDir = path.join(__dirname, 'src', 'chat');
    let html = fs.readFileSync(path.join(chatDir, 'chat.html'), 'utf8');
    const css = fs.readFileSync(path.join(chatDir, 'chat.css'), 'utf8');
    const js  = fs.readFileSync(path.join(chatDir, 'chat.js'), 'utf8');
    html = html.replace('/* INJECT_CSS */', css);
    html = html.replace('/* INJECT_JS */', js);
    fs.writeFileSync('./dist/chat.html', html, 'utf8');

    console.log('qqq-ai: build complete → dist/extension.js + dist/chat.html');
}

build().catch(e => { console.error(e); process.exit(1); });
