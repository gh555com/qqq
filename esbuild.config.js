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
        const result = await esbuild.build({
            entryPoints: ['./src/qqq.js'],
            bundle: true,
            outfile: './dist/qqq.js',
            external: ['vscode', 'diskusage'],
            format: 'cjs',
            platform: 'node',
            minify: true,
            sourcemap: false, // 生产环境关闭 sourcemap
            treeShaking: true, // 显式启用 tree-shaking 移除死代码
            drop: ['console', 'debugger'], // 移除调试代码
            legalComments: 'none', // 移除所有注释
            metafile: true, // 生成打包分析
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

        // 输出打包分析
        if (result.metafile) {
            const analysis = await esbuild.analyzeMetafile(result.metafile);
            console.log('📊 Bundle analysis:\n' + analysis);
            // 保存 metafile 供详细分析
            fs.writeFileSync('./dist/metafile.json', JSON.stringify(result.metafile, null, 2));
            console.log('📁 Metafile saved to dist/metafile.json');
        }
        console.log('✅ Bundling finished: dist/qqq.js');

        // ★ 拷贝 kp.py 和 miniaudio_v16.py 到 dist，确保它们在包里
        const pythonFiles = ['kp.py', 'miniaudio_v16.py'];
        for (const pyFile of pythonFiles) {
            const srcPath = `./src/${pyFile}`;
            const dstPath = `./dist/${pyFile}`;
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, dstPath);
                console.log(`✅ ${pyFile} copied to dist/${pyFile}`);
            }
        }
    } catch (e) {
        console.error('❌ Bundling failed:', e);
        process.exit(1);
    }
}

build();
