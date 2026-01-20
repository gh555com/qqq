const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
    console.log('🚀 Starting esbuild bundling...');

    // 确保 dist 目录存在
    if (!fs.existsSync('dist')) {
        fs.mkdirSync('dist');
    }

    try {
        await esbuild.build({
            entryPoints: ['./src/qqq.js'],
            bundle: true,
            outfile: './dist/qqq.js',
            external: ['vscode', '@ffmpeg-installer/ffmpeg'],
            format: 'cjs',
            platform: 'node',
            minify: process.env.NODE_ENV === 'production',
            sourcemap: true,
            // 处理特殊库的动态加载风险
            loader: {
                '.html': 'text',
                '.mp3': 'file',
                '.png': 'file',
                '.gif': 'file'
            },
            // 解决 __dirname 在 bundle 中指向不准确的问题
            define: {
                'process.env.NODE_ENV': '"production"'
            }
        });
        console.log('✅ Bundling finished: dist/qqq.js');
    } catch (e) {
        console.error('❌ Bundling failed:', e);
        process.exit(1);
    }
}

build();
