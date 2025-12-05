# File: q
{
    "name": "qqq",
    "displayName": "qqq",
    "publisher": "gh555",
    "version": "1.0.3",
    "description": "soldier",
    "icon": "assets/icon.png",
    "engines": {
        "vscode": "^1.70.0"
    },
    "activationEvents": [
        "*",
        "onCommand:qqq.q1",
        "onCommand:qqq.q2",
        "onCommand:qqq.toggleBlockMode"
    ],
    "main": "./src/qqq.js",
    "contributes": {
        "configuration": [
            {
                "title": "QQQ 扩展设置",
                "properties": {
                    "qqq.showHistoryRecycleBin": {
                        "type": "boolean",
                        "default": true,
                        "description": "是否在文件导航中显示历史回收站。"
                    }
                }
            }
        ],
        "commands": [
            {
                "command": "qqq.q1",
                "title": "qqq: q1"
            },
            {
                "command": "qqq.toggleBlockMode",
                "title": "切换块模式"
            },
            {
                "command": "qqq.q2",
                "title": "qqq: q2"
            },
            {
                "command": "qqq.saveAsDialog",
                "title": "qqq: 新建文件..."
            }
        ],
        "keybindings": [
            {
                "command": "qqq.q1",
                "key": "ctrl+v",
                "when": "editorTextFocus && !editorReadonly"
            },
            {
                "command": "qqq.q1",
                "key": "cmd+v",
                "when": "editorTextFocus && !editorReadonly"
            },
            {
                "command": "qqq.q2",
                "key": "f2",
                "when": "editorTextFocus && !editorReadonly"
            }
        ]
    },
    "dependencies": {
        "sharp": "^0.34.4",
        "trash": "^7.1.2"
    },
    "devDependencies": {
        "@types/node": "^18.0.0",
        "@types/vscode": "^1.70.0",
        "@vscode/vsce": "^3.6.2"
    }
}