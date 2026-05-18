with open('agent.js', 'r', encoding='utf-8') as f:
    content = f.read()

old = "            this._ctx = saved.ctx || { facts: [], narrative: '', turnSummaries: [], treasures: [], totalTurns: 0 };"
new = """            this._ctx = saved.ctx || { facts: [], narrative: '', turnSummaries: [], treasures: [], totalTurns: 0 };
            // 向后兼容：老版本 _ctx 可能缺少 turnSummaries/treasures 字段
            if (!Array.isArray(this._ctx.turnSummaries)) this._ctx.turnSummaries = [];
            if (!Array.isArray(this._ctx.treasures)) this._ctx.treasures = [];
            if (typeof this._ctx.totalTurns !== 'number') this._ctx.totalTurns = this._ctx.totalTurns || 0;"""

if old in content:
    content = content.replace(old, new)
    with open('agent.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('FIXED: _ctx restore now backward-compatible')
else:
    print('NOT FOUND, searching...')
    idx = content.find('saved.ctx ||')
    if idx >= 0:
        print(f'Found at offset {idx}: {repr(content[idx:idx+120])}')
    else:
        print('No saved.ctx found at all')
