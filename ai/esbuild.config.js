const esbuild = require('esbuild');
const fs = require('fs');

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

    // 拷贝 chat.html 到 dist（WebView 需要运行时读取）
    fs.copyFileSync('./src/chat/chat.html', './dist/chat.html');

    console.log('qqq-ai: build complete → dist/extension.js');
}

build().catch(e => { console.error(e); process.exit(1); });
