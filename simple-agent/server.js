/**
 * AI 面试助手 Agent 服务
 * 启动: npm run server 或 node server.js
 * 端口: process.env.PORT || 3456
 * API:
 *   GET  /api/health        -> { status: "ok", tools: [...] }
 *   POST /api/agent         -> 基于 AI 生成面试回答（流式）
 *   POST /api/profile       -> 保存候选人信息
 *   POST /api/resume/parse  -> 解析简历文本
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 20 * 1024 * 1024 } });

// 工具描述
const TOOLS = [
  { name: 'generate_answer', desc: 'AI 生成面试回答（调用大模型）' },
  { name: 'analyze_question', desc: '分析面试问题类型并推荐回答框架' },
  { name: 'parse_resume_text', desc: '解析简历文本提取结构化信息' }
];

// === Health ===
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', tools: TOOLS });
});

// === Profile ===
app.post('/api/profile', (req, res) => {
  const profile = req.body;
  const filePath = path.join(__dirname, 'profile.json');
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
  res.json({ status: 'saved', profile });
});

// === Resume Parse ===
app.post('/api/resume/parse', upload.single('file'), (req, res) => {
  let text = '';

  if (req.file) {
    try {
      text = fs.readFileSync(req.file.path, 'utf-8');
      fs.unlinkSync(req.file.path); // cleanup
    } catch (e) {
      return res.status(400).json({ error: '文件读取失败: ' + e.message });
    }
  } else if (req.body && req.body.text) {
    text = req.body.text;
  } else {
    return res.status(400).json({ error: '请提供文件或文本' });
  }

  const parsed = parseResumeText(text);
  res.json({ parsed: { ...parsed, rawLength: text.length } });
});

// === Agent 生成回答 ===
app.post('/api/agent', async (req, res) => {
  const { question, profile } = req.body;
  if (!question) return res.status(400).json({ error: '缺少 question' });

  // 尝试调用 AI API（如果有配置）
  const apiConfig = loadApiConfig();

  if (apiConfig && apiConfig.key) {
    await streamAIAnswer(question, profile, apiConfig, res);
  } else {
    // 无 AI API 时返回本地模板
    const answer = buildLocalAnswer(question, profile);
    res.json({
      answer,
      steps: [
        { type: 'thinking', step: 1, message: '分析问题类型...' },
        { type: 'tool_start', step: 2, tool: 'analyze_question', message: '推荐回答框架...' },
        { type: 'tool_done', step: 2, tool: 'analyze_question', message: '已选择框架' },
        { type: 'tool_start', step: 3, tool: 'generate_answer', message: '生成回答...' },
        { type: 'tool_done', step: 3, tool: 'generate_answer', message: '回答生成完成' }
      ]
    });
  }
});

// === AI 流式回答 ===
async function streamAIAnswer(question, profile, apiConfig, res) {
  const frameworks = getRecommendedFrameworks(question);
  const fwNames = frameworks.map(f => f.name).join(' + ');

  const systemPrompt = `你是一位资深面试教练。请生成专业、自然、可直接口述的中文面试回答。

候选人背景：
- 姓名：${profile?.name || '候选人'}
- 目标岗位：${profile?.target || '产品经理'}
- 亮点：${(profile?.highlights || []).join('；')}
- 项目：${profile?.projects || ''}

要求：
- 使用框架：${fwNames || 'STAR 结构化'}
- 回答长度 300-500 字，适合 1.5-2 分钟口述
- 结构清晰，语气自信
- 不要使用引导语，直接给出回答正文`;

  const url = (apiConfig.base || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiConfig.key
      },
      body: JSON.stringify({
        model: apiConfig.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        stream: true,
        temperature: 0.7
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      // 降级为本地回答
      const answer = buildLocalAnswer(question, profile);
      res.json({ answer, steps: [] });
      return;
    }

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';

    // SSE 流式返回
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // 先发送步骤
    const steps = JSON.stringify([
      { type: 'thinking', step: 1, message: '分析问题...' },
      { type: 'tool_start', step: 2, tool: 'analyze_question', message: `推荐框架: ${fwNames || 'STAR'}` },
      { type: 'tool_done', step: 2, tool: 'analyze_question', message: '框架选择完成' },
      { type: 'tool_start', step: 3, tool: 'generate_answer', message: 'AI 流式生成中...' }
    ]);
    res.write(`data: ${JSON.stringify({ type: 'steps', data: JSON.parse(steps) })}\n\n`);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullAnswer += delta;
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: delta })}\n\n`);
          }
        } catch { /* skip */ }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', text: fullAnswer })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'tool_done', step: 3, tool: 'generate_answer', message: '回答生成完成' })}\n\n`);
    res.end();
  } catch (e) {
    const answer = buildLocalAnswer(question, profile);
    res.json({ answer, steps: [] });
  }
}

// === 本地工具函数 ===

function parseResumeText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let name = '';
  let target = '';
  const highlights = [];
  let projects = '';

  // 姓名
  const nameMatch = text.match(/姓名[：:]\s*(\S+)/);
  if (nameMatch) name = nameMatch[1];
  else if (lines[0] && lines[0].length <= 4) name = lines[0];

  // 目标岗位
  const targetMatch = text.match(/(?:目标岗位|求职意向|应聘)[：:]\s*(.+)/);
  if (targetMatch) target = targetMatch[1].trim();

  // 亮点
  for (const line of lines) {
    if (line.includes('亮点') || line.includes('技能') || line.includes('熟悉') || line.includes('擅长') || line.includes('负责')) {
      if (line.length > 4 && line.length < 100) highlights.push(line);
    }
  }
  if (highlights.length < 3) {
    const expLines = lines.filter(l =>
      (l.includes('经验') || l.includes('负责') || l.includes('产品') || l.includes('数据') || l.includes('分析') || l.includes('设计') || l.includes('运营') || l.includes('开发') || l.includes('管理'))
      && l.length > 8 && l.length < 100
    );
    for (const l of expLines) {
      if (!highlights.includes(l)) highlights.push(l);
    }
  }

  // 项目经历（增强版）
  projects = extractProjectsServer(lines, text, highlights);

  return { name, target, highlights: highlights.slice(0, 8), projects };
}

/**
 * 服务端增强版项目经历解析（与前端逻辑一致）
 */
function extractProjectsServer(lines, fullText, highlights) {
  // 找到项目板块
  let sectionStart = -1;
  let sectionEnd = lines.length;
  const sectionHeaders = ['项目经历', '项目经验', '项目作品', '主要项目', '项目案例'];
    for (let i = 0; i < lines.length; i++) {
      // 板块标题必须独立成行，不含其他内容，排除正文中的关键词误匹配
      if (sectionHeaders.some(h => lines[i] === h || lines[i].startsWith(h + '：') || lines[i].startsWith(h + ':') || lines[i].startsWith(h + ' '))) {
        sectionStart = i + 1;
        break;
      }
    }

  if (sectionStart === -1) {
    // 全文搜索项目信息
    const projectKeywords = ['项目', '负责', '主导', '参与', '搭建', '开发', '设计', '优化', '上线', '产品', '实现', '完成'];
    const candidates = [];
    for (const line of lines) {
      const matchCount = projectKeywords.filter(k => line.includes(k)).length;
      if (matchCount >= 2 && line.length > 15 && line.length < 200) {
        candidates.push(line);
      }
    }
    if (candidates.length === 0 && fullText) {
      const paraMatch = fullText.match(/[^。\n]{10,}(经验|项目|负责)[^。\n]{10,}[。\n]/g);
      if (paraMatch) return paraMatch.slice(0, 3).map(p => p.trim()).join('\n');
    }
    return candidates.slice(0, 4).join('\n') || (highlights.length > 0 ? highlights.slice(0, 2).join('\n') : '');
  }

  const nextSections = ['教育背景', '工作经历', '技能', '自我评价', '荣誉', '证书', '培训经历', '语言能力'];
  for (let i = sectionStart; i < lines.length; i++) {
    if (nextSections.some(s => lines[i].includes(s))) {
      sectionEnd = i;
      break;
    }
  }

  const projectLines = lines.slice(sectionStart, sectionEnd);
  const blocks = splitProjectBlocksServer(projectLines);

  return blocks.map((block, idx) => parseSingleProjectServer(block, idx + 1)).join('\n\n');
}

function splitProjectBlocksServer(lines) {
  const blocks = [];
  let current = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;

    const isNumbered = /^\d+[\.\)）、]/.test(trimmed);
    const isDatePrefixed = /^\d{4}[年\/\.-]\s*\d{0,2}[月\/\.-]?\s*(?:[-–—~至到]\s*\d{4}[年\/\.-]\s*\d{0,2}[月\/\.-]?\s*(?:至今|现在|当前)?)?/.test(trimmed);
    const isBracketPrefixed = /^【[\u4e00-\u9fa5]/.test(trimmed);
    const isNewProject = isNumbered || isDatePrefixed || isBracketPrefixed;

    if (isNewProject && current.length > 0) {
      blocks.push([...current]);
      current = [];
    }

    if (/^[-–—=]{3,}$/.test(trimmed)) continue;
    current.push(trimmed);
  }

  if (current.length > 0) blocks.push([...current]);
  if (blocks.length === 0 && lines.length > 0) blocks.push([...lines]);
  return blocks;
}

function parseSingleProjectServer(lines, idx) {
  let name = '', time = '', role = '', tech = '', description = '', achievements = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || /^\d{1,2}$/.test(trimmed)) continue;

    const timeMatch = trimmed.match(/(\d{4}[年\/\.-]\s*\d{0,2}[月\/\.-]?\s*(?:[-–—~至到]\s*\d{4}[年\/\.-]\s*\d{0,2}[月\/\.-]?\s*(?:至今|现在|当前)?)?)/);
    if (timeMatch && !name) {
      time = timeMatch[1].replace(/[年月]/g, '.').replace(/[日号]/g, '').replace(/\.$/, '');
      continue;
    }

    const roleMatch = trimmed.match(/[角色职责职位][：:]\s*(.+)/) || trimmed.match(/(产品经理|产品负责人|项目经理|产品运营|数据分析师|开发工程师|设计师|项目组长|项目负责人|团队负责人|技术负责人|产品助理|产品总监)/);
    if (roleMatch && !role) { role = roleMatch[1] || roleMatch[0]; continue; }

    const techMatch = trimmed.match(/[技术栈工具语言][：:]\s*(.+)/);
    if (techMatch) { tech = techMatch[1]; continue; }

    // 显式标记"描述"行 → 归入描述
    if (trimmed.startsWith('描述') || trimmed.startsWith('说明') || trimmed.startsWith('简介')) {
      description += (description ? '\n' : '') + trimmed.replace(/^描述[：:]\s*/, '').replace(/^说明[：:]\s*/, '').replace(/^简介[：:]\s*/, '');
      continue;
    }

    const achievementMatch = trimmed.match(/[成果业绩成效结果数据][：:]\s*(.+)/)
      || trimmed.match(/(提升|降低|增长|达到|突破|实现|完成|获得|上线|交付|覆盖|DAU|MAU|GMV|留存|转化|UV|PV)[^。\n]*[0-9%.]+\S*/);
    if (achievementMatch) {
      achievements += (achievements ? '；' : '') + achievementMatch[0].replace(/^[成果业绩成效结果数据][：:]\s*/, '');
      continue;
    }

    if (!name && trimmed.length < 60 && /[\u4e00-\u9fa5]/.test(trimmed)) {
      const cleanName = trimmed.replace(/^\d+[\.\)）、]\s*/, '').replace(/^【|】$/g, '').replace(/[（(].*[）)]$/, '').trim();
      if (cleanName.length > 2 && cleanName.length < 50) { name = cleanName; continue; }
    }

    if (trimmed.length > 6) {
      if (/(提升|降低|增长|达到|突破|实现|完成|获得|上线|交付|覆盖|DAU|MAU|GMV|留存|转化|UV|PV|率)/.test(trimmed) && /\d/.test(trimmed)) {
        achievements += (achievements ? '；' : '') + trimmed;
      } else {
        description += (description ? '\n' : '') + trimmed;
      }
    }
  }

  if (!name && lines.length > 0) name = lines[0].replace(/^\d+[\.\)）、]\s*/, '').replace(/^【|】$/g, '').replace(/[（(].*[）)]$/, '').trim().substring(0, 40);

  const parts = [`【项目${idx}】${name || '未命名项目'}`];
  if (time) parts.push(`  时间：${time}`);
  if (role) parts.push(`  角色：${role}`);
  if (tech) parts.push(`  技术栈：${tech}`);
  if (description) parts.push(`  描述：${description.substring(0, 200)}`);
  if (achievements) parts.push(`  成果：${achievements.substring(0, 200)}`);

  if (!description && !achievements) {
    const descLines = lines.filter(l => l.trim().length > 6 && !l.includes(name) && !l.match(/^\d{4}/));
    if (descLines.length > 0) {
      parts.push(`  描述：${descLines.slice(0, 3).join('；').substring(0, 200)}`);
    }
  }

  return parts.join('\n');
}

function buildLocalAnswer(question, profile) {
  const name = profile?.name || '我';
  const target = profile?.target || '产品经理';
  const fwNames = getRecommendedFrameworks(question).map(f => f.name).join(' + ') || 'STAR';
  return `【${fwNames}】

您好，我是${name}，目标岗位是${target}。

关于您的问题，我的思路如下：

首先，我认为这个问题的核心在于…（结合框架展开）

其次，我过往的经验是…（结合个人经历）

最后，总结来说…（给出结论）

（提示：使用 AI API 获取更高质量的回答。在设置中填写 API Key 后切换到 "AI 生成" 或 "Agent 模式"）`;
}

function getRecommendedFrameworks(question) {
  const q = question.toLowerCase();
  const map = [
    { keywords: ['自我介绍', '介绍', 'self'], fws: [{ name: '1-3-1 结构' }, { name: 'SWOT' }] },
    { keywords: ['项目', '经历', '负责'], fws: [{ name: 'STAR' }, { name: 'AARRR' }] },
    { keywords: ['优先级', '评估', '做不做', '排期'], fws: [{ name: 'RICE' }, { name: 'KANO' }] },
    { keywords: ['数据', '指标', '增长', '下降', 'DAU'], fws: [{ name: 'AARRR' }, { name: 'HEART' }] },
    { keywords: ['竞品', '市场', '竞争'], fws: [{ name: '3C' }, { name: 'SWOT' }, { name: 'PEST' }] },
    { keywords: ['MVP', '从0到1'], fws: [{ name: 'MVP' }, { name: 'RICE' }] },
    { keywords: ['冲突', '分歧', '团队', '推动'], fws: [{ name: 'STAR' }, { name: 'SWOT' }] },
    { keywords: ['用户体验', '体验'], fws: [{ name: 'User Journey Map' }, { name: 'HEART' }] },
    { keywords: ['AI', '人工智能'], fws: [{ name: '3C' }, { name: 'MVP' }] },
  ];
  for (const entry of map) {
    if (entry.keywords.some(k => q.includes(k))) return entry.fws;
  }
  return [{ name: 'STAR' }];
}

function loadApiConfig() {
  try {
    // 读取前端保存的 API 配置（从 localStorage 间接获取）
    const apiDir = path.join(__dirname, '..');
    // 简单返回空，实际配置由前端传入
    return null;
  } catch { return null; }
}

// === 静态文件服务（可选）===
app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
  console.log(`[Agent Server] 运行在 http://localhost:${PORT}`);
  console.log(`[Agent Server] 工具数: ${TOOLS.length}`);
  console.log(`[Agent Server] API 端点:`);
  console.log(`  GET  /api/health`);
  console.log(`  POST /api/agent`);
  console.log(`  POST /api/profile`);
  console.log(`  POST /api/resume/parse`);
});
