import {createHash} from "node:crypto";

export const TURING_QUALITY_SCRIPT_SHA256 = "3bb09b31387a8cc7eb8148eabe7688c787697eb809f1d602f81b4e21f8f393df";
export type TavernQualityHit = {name: string; count: number; samples: string[]; note: string; fix?: string};
export type TavernQualityReport = {
    adapter: "turing-local-v3.11"; sourceSha256: string; scopeTag: string; scoped: boolean;
    characters: number; hits: TavernQualityHit[]; total: number; cloudReview: "not-configured";
};

type Rule = {name: string; note: string; pattern: string; fix?: string};
type FrequencyRule = Rule & {max: number};

// These literal rules reproduce only this script revision's local lint. A changed script must get a new reviewed adapter.
const RULES: readonly Rule[] = [
    {
        "name": "ban词直杀",
        "note": "预设<BAN>明令词汇，直接禁",
        "pattern": "(弧度|不容置疑|不易察觉|生理性|泛白|盘缠|不容[一-龥])"
    },
    {
        "name": "熟练度申报",
        "note": "熟练由动作准确性呈现，不许旁白申报",
        "pattern": "(熟练得像|像做过几百次|像做过无数次|行云流水|驾轻就熟|一气呵成|轻车熟路|炉火纯青|游刃有余|信手拈来|熟门熟路)"
    },
    {
        "name": "对白功能注解",
        "note": "对白的作用由对方反应呈现，旁白不宣布",
        "pattern": "(结束了话题|岔开了话题|转移了话题|递了个台阶|给了个台阶|递台阶|打破了沉默|打破沉默|化解了尴尬|缓解了气氛|打破了僵局|打破僵局)"
    },
    {
        "name": "补了一句填腔",
        "note": "对白之间的无意义填充句",
        "pattern": "(补了一句|补了句|补充了一句|补充道|又说了一句|加了一句|添了一句)"
    },
    {
        "name": "拍瞬过场",
        "note": "一瞬/一拍式直白停拍，转场偷懒",
        "fix": "删了不影响语义就直接删；若是过场填充（静了一瞬/顿了一拍），换更好的过场：人物反应、具体动作，或干脆留白",
        "pattern": "(一瞬|一拍)"
    },
    {
        "name": "劈叉",
        "note": "声音失控的库存比喻（声音劈了叉）",
        "fix": "直接删，或换成具体听感：破音/哑在半路/尾音压不住；也可以让听者的反应来体现",
        "pattern": "劈了?叉"
    },
    {
        "name": "对白重归属",
        "note": "引号外动作已点名说话人，段间又写\"他说\"",
        "fix": "删掉\"他说/她道\"，两段引号直接相接或并成一段",
        "pattern": "[」\"](?:他|她|它)?(?:说|道|问|答|开口|出声)[，,][「\"]"
    },
    {
        "name": "对白间过场",
        "note": "对白之间的节拍填充（他顿了顿/摇了摇头），删",
        "pattern": "[”」』\"]。?\\s*[^“”「『』\"。！？]{0,6}(?:顿了顿|停了停|摇了摇头|笑了笑|点了点头|摆了摆手|叹了口气|皱了皱眉|挑了挑眉|眯了眯眼|咳了一声|顿了一下)[^“”「『\"。！？]{0,10}[。，,]?\\s*(?=[“「『\"])"
    },
    {
        "name": "身体细节特写",
        "note": "对人物身体细节过度刻画",
        "pattern": "(指节|指腹|脚趾|胸口起伏|茧子)"
    },
    {
        "name": "身体部位演戏",
        "note": "身体部位只能当宾语，不许自己行动",
        "pattern": "(指尖|唇角|眉梢|眼尾|眉骨|喉结|睫毛|掌心|脊背|下巴|颧骨|肩头|膝盖|舌尖|指缝|发梢|眼角|嘴角|手背|脚踝)(?:轻轻|微微|慢慢|倏地|蓦地|悄悄)?(?:抬|弯|颤|抖|收紧|绷紧|蜷缩|张开|滑落|爬上|贴近|环住|扣住|扬起|勾起|沉|僵|软|翘|抽|缩|绷|压|抵|蹭|摩挲)"
    },
    {
        "name": "声音质感修饰",
        "note": "叙事不描写说话的声音/语气（亲密场景喘息闷哼豁免）",
        "pattern": "(声音里带|嗓音里|语调里|声线里|音色|音量|沙哑|嘶哑|一字一顿|一字一句|[轻低哑沉冷柔淡闷颤哽]声地)"
    },
    {
        "name": "声音做主语",
        "note": "声音不该当主语演戏，改成人做主语",
        "pattern": "(声音|嗓音|声线|声调|语调|语气|话音|话语|叹息|笑声|鼻息|呼吸|心跳)(?:在|里|中|间|上)?(颤|抖|飘|落|砸|滚|撞|炸|断|哽|涩|沉|低|哑|软|冷|硬|拔|提|压|缓|顿|扬|带|透|染|掺|裹|含|藏|浮|漫|爬|平)"
    },
    {
        "name": "目光做主语",
        "note": "目光落在=前科。谁在看就写谁看",
        "pattern": "(目光|视线|眼神|眸光|眼底)(?:在|里|中|间)?(落|扫|黏|钉|锁|压|滑|游|飘|沉|冷|烫|暗|亮|闪|敛|垂|抬)"
    },
    {
        "name": "认账八股",
        "note": "我认了/我认栽式洒脱结案，人人输得起",
        "pattern": "[，,]?\\s*我认(?:了|栽|罚|账)?[。！!]"
    },
    {
        "name": "落空尾巴",
        "note": "铺垫半天的动作，句尾两个字撤回（，没拿。）",
        "pattern": "，(?:却没|没有|也没|没|却不)[^。！？，]{0,4}[。！？]"
    },
    {
        "name": "破折号注解",
        "note": "不用破折号转折/补充信息（对白被打断豁免）",
        "pattern": "——"
    },
    {
        "name": "逗号拖尾",
        "note": "主干说完就句号，状语尾巴不许寄生句尾",
        "pattern": "，(?:带着|动作|语气|声音|神色|表情|姿态|步伐|脚步|样子|背影)[^。！？]{1,12}[。！？]"
    },
    {
        "name": "是那种定义句",
        "note": "非对白不写\"是那种…\"冗余定义句",
        "pattern": "(是那种|是这样一种|算是一种)"
    },
    {
        "name": "兽喻角色",
        "note": "不以兽类比喻出场角色（真动物豁免）",
        "pattern": "(小兽|幼兽|困兽|大猫|野兽般|像只[一-龥]{1,3}|像头[一-龥]{1,3})"
    },
    {
        "name": "否定壳排比",
        "note": "没有…没有…换壳排比",
        "pattern": "没有[^。！？]{1,15}[^。！？]*没有"
    },
    {
        "name": "不是…是转折腔",
        "note": "书面否定肯定转折句（是不是不算）",
        "pattern": "不是(?!不)[^。！？]{1,15}，(?:是|而是|反倒是)|不是(?!不)[^。！？]{1,15}(?:而是|反倒是)"
    },
    {
        "name": "注释尾巴",
        "note": "主干+逗号+比喻注释",
        "pattern": "，(?:像是|仿佛|如同|好似|恍若|恰如|像极了)[^。！？]{2,25}[。！？]"
    },
    {
        "name": "口语逗号强调",
        "note": "这菜，好吃式断句",
        "pattern": "[这那][一-龥]{1,3}，(?:好|绝|妙|香|甜|对|行|成|棒)"
    },
    {
        "name": "伪精确报数",
        "note": "叙述者没有尺子也没有表",
        "pattern": "(半步|半寸|半秒|半拍|刹那|霎时|一丝|一毫|分毫|毫米|厘米|毫秒)"
    },
    {
        "name": "量词堆叠",
        "note": "一下又一下式计数癖",
        "pattern": "(一下|一次|一遍|一阵|一步|一口|一眼)又(一下|一次|一遍|一阵|一步|一口|一眼)"
    },
    {
        "name": "道具清点",
        "note": "拿了X又拿Y",
        "pattern": "拿[了起住][^。！？]{0,12}?又拿"
    },
    {
        "name": "加冕句",
        "note": "只有他能接住我式谄媚独白",
        "pattern": "(只有|唯有)[^。！？]{0,12}(?:能|配|懂|接得住|接住|值得)"
    },
    {
        "name": "谈判关键词",
        "note": "交易腔粗筛",
        "pattern": "(谈个条件|讲条件|做个交易|做笔交易|等价交换|收点利息|连本带利|讨债|还清)"
    },
    {
        "name": "单字呼句平收",
        "note": "呼喊/报警式短句用句号平收（「火。」），标点不随情绪",
        "pattern": "[「\"“][^「」“”\"\\s。！？]{1,3}。[」\"”]"
    },
    {
        "name": "否定式伪结果",
        "note": "拿\"没发生什么\"冒充动作结果（灰没飞起来/没发出声响）",
        "pattern": "，[^，。！？」\"]{0,6}没(?:有|能|敢)?[^，。！？」\"]{1,8}[。！？]"
    }
];
const FREQUENCY_RULES: readonly FrequencyRule[] = [
    {
        "name": "频率·明喻超标",
        "pattern": "(像是?|仿佛|如同|宛如|犹如|好似)",
        "max": 3,
        "note": "明喻密度上限3处/千字：先删意义盖章式与库存喻体，保留新鲜准确的"
    },
    {
        "name": "频率·tic词超标",
        "pattern": "(缓缓|微微|轻轻|淡淡|嘴角)",
        "max": 5,
        "note": "缓缓/微微/轻轻/淡淡/嘴角合计上限5处/千字：删除或换具体动作"
    }
];

export function isSupportedTuringQualityScript(content: string): boolean {
    return createHash("sha256").update(content).digest("hex") === TURING_QUALITY_SCRIPT_SHA256;
}

/** Local hints remain suspicions for the writing reviewer; they never patch or reject prose automatically. */
export function scanTuringQuality(stored: string, scopeTag = ""): TavernQualityReport {
    if (scopeTag && !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(scopeTag)) throw new Error("质检标签名称无效");
    const scoped = scopeTag ? stored.match(new RegExp("<" + scopeTag + ">([\\s\\S]*?)</" + scopeTag + ">", "i")) : null;
    const text = (scoped?.[1] ?? stored).replace(/<think[\s\S]*?<\/think>/gi, "")
        .replace(/```[\s\S]*?```/g, "").replace(/<[^>]+>/g, "");
    const hits: TavernQualityHit[] = [];
    for (const rule of RULES) {
        const regex = new RegExp(rule.pattern, "g");
        const samples: string[] = [];
        let count = 0, match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null && count < 99) {
            count += 1;
            if (samples.length < 2) samples.push(match[0]);
        }
        if (count) hits.push({name: rule.name, count, samples, note: rule.note, fix: rule.fix ?? ""});
    }
    const perK = text.length / 1000 || 1;
    for (const rule of FREQUENCY_RULES) {
        const regex = new RegExp(rule.pattern, "g");
        let count = 0;
        while (regex.exec(text) !== null && count < 999) count += 1;
        const density = count / perK;
        if (density > rule.max) hits.push({name: rule.name, count, samples: [`${density.toFixed(1)}处/千字，上限${rule.max}`],
            note: rule.note, fix: "密度病，不逐条修：挑最典型的几处给修改示范即可"});
    }
    const tail = text.trim().slice(-80);
    if (/[？?]["'」』）)]?\s*$/u.test(tail)) hits.push({name: "递话筒结尾", count: 1,
        samples: [tail.slice(-20)], note: "一轮剧情以NPC问话收尾"});
    return {adapter: "turing-local-v3.11", sourceSha256: TURING_QUALITY_SCRIPT_SHA256, scopeTag, scoped: scoped !== null,
        characters: text.length, hits, total: hits.reduce((sum, hit) => sum + hit.count, 0), cloudReview: "not-configured"};
}

