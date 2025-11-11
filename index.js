// Karin 版本的“娶群友/强娶/闹离婚/对象列表”插件
// 特性：分群存储；名片跨适配器获取；结婚记录带时间戳；超过24h自动解除；定时清理任务；显示为北京时间（GMT+8）

import { karin, segment, logger } from 'node-karin'

/** ========== 分群数据结构（内存态；可改为持久化到 @karinjs/<plugin>/data） ========== */
/**
 * Map<groupIdString, {
 *   couples: Array<{man: string|number, woman: string|number, createdAt: number}>,
 *   names:   Array<{man: string, woman: string}>
 * }>
 */
const GROUPS = new Map()

/** ========== 小工具 ========== */
const toStr = (v) => (v == null ? '' : String(v))
const sameId = (a, b) => toStr(a) === toStr(b)
const asNumberOrString = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? { n, s: String(v) } : { n: undefined, s: String(v) }
}
const keyGet = (map, id) => {
  if (!map) return undefined
  const { n, s } = asNumberOrString(id)
  return map.get?.(id) || (n !== undefined && map.get?.(n)) || map.get?.(s)
}
const DAY_MS = 24 * 60 * 60 * 1000

function getGid(ctx) {
  return ctx.group_id || ctx.group?.group_id
}

function ensureGroup(ctx) {
  const gid = getGid(ctx)
  if (!gid) return { ok: false, msg: '这条指令仅限群聊使用~', gid: null, data: null }
  const key = toStr(gid)
  if (!GROUPS.has(key)) GROUPS.set(key, { couples: [], names: [] })
  return { ok: true, gid: key, data: GROUPS.get(key) }
}

/** 北京时间（GMT+8）格式化，仅用于展示；逻辑仍按 UTC 时间戳算 */
function formatBeijingTime(ms) {
  const d = new Date((ms ?? Date.now()) + 8 * 60 * 60 * 1000) // UTC → GMT+8
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} (GMT+8)`
}

/** ========== 过期清理：超过24小时自动解除 ========== */
function cleanupGroupExpired(groupKey, data) {
  const { couples, names } = data
  const now = Date.now()
  let removed = 0
  for (let i = couples.length - 1; i >= 0; i--) {
    const rec = couples[i]
    if (!rec?.createdAt || (now - rec.createdAt) > DAY_MS) {
      couples.splice(i, 1)
      names.splice(i, 1)
      removed++
    }
  }
  if (removed) logger.debug?.(`[marry-cleanup] group=${groupKey} removed=${removed}`)
  return removed
}

/** 头像 **/
const avatarUrl = (qq) => `http://q2.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=5`

/** 解析首个@对象（兼容不同适配器的字段） **/
function firstAt(ctx) {
  const at = ctx.at || ctx.atUser
  if (at) return Array.isArray(at) ? at[0] : at

  const msg = ctx.message || ctx.segs || ctx.segments
  if (Array.isArray(msg)) {
    const seg = msg.find(s => s?.type === 'at' && (s.qq || s.user_id || s.userId || s.id))
    if (seg) return seg.qq ?? seg.user_id ?? seg.userId ?? seg.id
  }
  return undefined
}

/** ========== 取名：跨适配器多级策略 ========== */
async function getMemberName(ctx, groupId, userId, mmap /* 可选：已拿到成员表 */) {
  const gid = groupId ?? getGid(ctx)
  const uid = userId
  const uidStr = toStr(uid)
  const pickName = (m) => m && (m.card || m.nickname || m.user_name || m.name || m.displayName || m.remark || m.title)

  // 1) getMemberMap
  try {
    const map = mmap || (await ctx.group?.getMemberMap?.())
    const m = keyGet(map, uid)
    const name = pickName(m)
    if (name) {
      logger.debug?.(`[getMemberName] getMemberMap: ${uidStr} => ${name}`)
      return name
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getMemberMap fail: ${e?.message || e}`)
  }

  // 2) getMember
  try {
    if (ctx.group?.getMember) {
      const m = await ctx.group.getMember(uid)
      const name = pickName(m)
      if (name) {
        logger.debug?.(`[getMemberName] getMember: ${uidStr} => ${name}`)
        return name
      }
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getMember fail: ${e?.message || e}`)
  }

  // 3) OneBot / Go-CQHTTP
  try {
    if (ctx.bot?.getGroupMemberInfo && gid != null) {
      const { n, s } = asNumberOrString(uid)
      const gidNum = Number(gid)
      const info = await ctx.bot.getGroupMemberInfo(gidNum || gid, n ?? s, true)
      const name = info?.card || info?.nickname
      if (name) {
        logger.debug?.(`[getMemberName] getGroupMemberInfo: ${uidStr} => ${name}`)
        return name
      }
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getGroupMemberInfo fail: ${e?.message || e}`)
  }

  // 4) 通用 API
  try {
    if (typeof ctx.getDisplayName === 'function') {
      const name = await ctx.getDisplayName(uid, gid)
      if (name) {
        logger.debug?.(`[getMemberName] getDisplayName: ${uidStr} => ${name}`)
        return name
      }
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getDisplayName fail: ${e?.message || e}`)
  }
  try {
    if (ctx.bot?.getGuildMemberProfile && gid != null) {
      const prof = await ctx.bot.getGuildMemberProfile(gid, uid)
      const name = pickName(prof)
      if (name) {
        logger.debug?.(`[getMemberName] getGuildMemberProfile: ${uidStr} => ${name}`)
        return name
      }
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getGuildMemberProfile fail: ${e?.message || e}`)
  }

  // 5) getMemberList
  try {
    if (ctx.group?.getMemberList) {
      const list = await ctx.group.getMemberList()
      const m = (list || []).find(x =>
        sameId(x?.user_id ?? x?.userId ?? x?.id ?? x?.uid, uid)
      )
      const name = pickName(m)
      if (name) {
        logger.debug?.(`[getMemberName] getMemberList: ${uidStr} => ${name}`)
        return name
      }
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] getMemberList fail: ${e?.message || e}`)
  }

  // 6) legacy pickMember
  try {
    const legacy = ctx.bot?.pickMember?.(gid, uid)
    const name = pickName(legacy)
    if (name) {
      logger.debug?.(`[getMemberName] legacy pickMember: ${uidStr} => ${name}`)
      return name
    }
  } catch (e) {
    logger.debug?.(`[getMemberName] legacy pickMember fail: ${e?.message || e}`)
  }

  logger.warn?.(`[getMemberName] 未能取到名片，使用 QQ 号：${uidStr}`)
  return uidStr
}

/** ========== 群级别的索引/判断（注意：务必先 cleanup 才准确） ========== */
const findByMan   = (arr, uid) => arr.findIndex(v => sameId(v.man, uid))
const findByWoman = (arr, uid) => arr.findIndex(v => sameId(v.woman, uid))
const hasPartner  = (arr, uid) => (findByMan(arr, uid) !== -1) || (findByWoman(arr, uid) !== -1)

/** ========== 指令实现（分群 + 过期清理 + GMT+8 显示） ========== */

/** 列表：#群对象列表（列出前自动清理过期记录） */
export const listPairs = karin.command('^(#)?群对象列表$', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { gid, data } = g

  // 先清一次
  cleanupGroupExpired(gid, data)

  const { couples, names } = data
  if (!couples.length) {
    return ctx.reply('当前还没有“官宣”的对象~ 先去努力脱单吧 (ง •̀_•́)ง')
  }

  const mmap = await ctx.group?.getMemberMap?.().catch(() => null)
  const lines = await Promise.all(couples.map(async (p, i) => {
    const n = names[i] || {}
    let manName   = n.man
    let womanName = n.woman

    if (!manName || manName === toStr(p.man)) {
      manName = await getMemberName(ctx, gid, p.man, mmap)
    }
    if (!womanName || womanName === toStr(p.woman)) {
      womanName = await getMemberName(ctx, gid, p.woman, mmap)
    }
    names[i] = { man: manName, woman: womanName }

    const timeStr = formatBeijingTime(p.createdAt || Date.now())
    return `${i + 1}. ${manName}(${p.man}) ❤ ${womanName}(${p.woman})  [${timeStr}]`
  }))

  return ctx.reply(['【今日群对象列表】\n', lines.join('\n')])
}, { name: '群对象列表' })

/** 我对象呢：进入前清理 */
export const myPartner = karin.command('^(#)?我对象呢$', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { gid, data } = g

  cleanupGroupExpired(gid, data)

  const { couples, names } = data
  const uid = ctx.user_id || ctx.sender?.user_id
  const i1 = findByMan(couples, uid)
  const i2 = findByWoman(couples, uid)

  if (i1 === -1 && i2 === -1) {
    return ctx.reply('醒醒…你还没有对象呢。要不先去“娶群友/强娶”试试？')
  }

  if (i1 !== -1) {
    const target = couples[i1].woman
    return ctx.reply([
      segment.at(uid), '\n你今天的老婆是 ',
      segment.image(avatarUrl(target)),
      names[i1].woman || toStr(target), `(${toStr(target)})`,
      '\n看好她哦，别让她被抢走了。'
    ])
  }

  if (i2 !== -1) {
    const target = couples[i2].man
    return ctx.reply([
      segment.at(uid), '\n你今天的老公是 ',
      segment.image(avatarUrl(target)),
      names[i2].man || toStr(target), `(${toStr(target)})`,
      '\n看好他哦，别让他被抢走了。'
    ])
  }
}, { name: '查询对象' })

/** 闹离婚：进入前清理 */
export const divorce = karin.command('^(#)?闹离婚$', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { gid, data } = g

  cleanupGroupExpired(gid, data)

  const { couples, names } = data
  const uid = ctx.user_id || ctx.sender?.user_id
  const i1 = findByMan(couples, uid)
  const i2 = findByWoman(couples, uid)

  if (i1 === -1 && i2 === -1) {
    return ctx.reply('你连对象都没有，跟谁离婚呢。')
  }

  if (i1 !== -1) {
    couples.splice(i1, 1)
    names.splice(i1, 1)
  } else if (i2 !== -1) {
    couples.splice(i2, 1)
    names.splice(i2, 1)
  }

  return ctx.reply('没想到你们走到了这一步，那就江湖再见吧。')
}, { name: '闹离婚' })

/** 强娶：进入前清理 + 写入 createdAt */
export const forceMarry = karin.command('^(#)?强娶', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { gid, data } = g

  cleanupGroupExpired(gid, data)

  const { couples, names } = data
  const uid = ctx.user_id || ctx.sender?.user_id
  const target = firstAt(ctx)

  if (!target) return ctx.reply('强娶谁？至少 @ 一下目标人选。')
  if (sameId(target, uid)) return ctx.reply('自恋过头了，不能和自己结婚。')

  // 已有对象检查（自己/目标）
  if (hasPartner(couples, uid)) {
    const i1 = findByMan(couples, uid)
    const i2 = findByWoman(couples, uid)
    if (i1 !== -1) {
      const t = couples[i1].woman
      return ctx.reply([
        segment.at(uid), '\n你今天已经有老婆啦 ',
        segment.image(avatarUrl(t)), names[i1].woman || toStr(t), `(${toStr(t)})`,
        '\n别三心二意了！好好珍惜她！'
      ])
    }
    if (i2 !== -1) {
      const t = couples[i2].man
      return ctx.reply([
        segment.at(uid), '\n你今天已经被他娶走啦 ',
        segment.image(avatarUrl(t)), names[i2].man || toStr(t), `(${toStr(t)})`,
        '\n别三心二意了！好好珍惜他！'
      ])
    }
  }

  if (hasPartner(couples, target)) {
    return ctx.reply('对方今天已经被娶走了，另寻良缘吧。')
  }

  // 成交
  const mmap = await ctx.group?.getMemberMap?.().catch(() => null)
  const womanName = await getMemberName(ctx, gid, target, mmap)
  const manName   = ctx.member?.card || ctx.sender?.card || ctx.nickname || toStr(uid)

  couples.push({ man: uid, woman: target, createdAt: Date.now() })
  names.push({ man: manName, woman: womanName })

  return ctx.reply([
    segment.at(uid), '\n你今天的老婆是 ',
    segment.image(avatarUrl(target)),
    womanName, `(${toStr(target)})`,
    '\n看好她哦，别让她被抢走了。'
  ])
}, { name: '强娶', at: false })

/** 抢群友：进入前清理 + 写入 createdAt（70% 失败） */
export const snatch = karin.command('^(#)?抢群友', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { gid, data } = g

  cleanupGroupExpired(gid, data)

  const { couples, names } = data
  const uid = ctx.user_id || ctx.sender?.user_id
  const target = firstAt(ctx)

  if (!target) return ctx.reply('你到底想抢谁？抢空气吗？')
  if (hasPartner(couples, uid)) return ctx.reply('你都已经有对象了，还想抢？先把人品修好再说。')
  if (!hasPartner(couples, target)) return ctx.reply('对方还没有对象呢，直接“强娶”就好了。')

  const luck = Math.floor(Math.random() * 100)
  if (luck < 70) return ctx.reply('没抢到，欸嘿~ 再接再厉。')

  // 从原配剥离
  const i3 = findByMan(couples, target)
  const i4 = findByWoman(couples, target)
  const mmap = await ctx.group?.getMemberMap?.().catch(() => null)
  const nameTarget = await getMemberName(ctx, gid, target, mmap)
  const myName = ctx.member?.card || ctx.sender?.card || ctx.nickname || toStr(uid)

  if (i3 !== -1) {
    couples.splice(i3, 1)
    names.splice(i3, 1)
  } else if (i4 !== -1) {
    couples.splice(i4, 1)
    names.splice(i4, 1)
  }

  couples.push({ man: uid, woman: target, createdAt: Date.now() })
  names.push({ man: myName, woman: nameTarget })

  return ctx.reply([
    segment.at(uid), '\n你成功抢到了她 ',
    segment.image(avatarUrl(target)),
    nameTarget, `(${toStr(target)})`,
    '\n运气不错嘛！'
  ])
}, { name: '抢群友' })

/** 随机娶群友：进入前清理 + 写入 createdAt（30% 失败） */
export const marryRandom = karin.command('^(#)?娶群友$', async (ctx) => {
  const g = ensureGroup(ctx)
  if (!g.ok) return ctx.reply(g.msg)
  const { data } = g

  cleanupGroupExpired(g.gid, data)

  const { couples, names } = data
  const uid = ctx.user_id || ctx.sender?.user_id
  const fail = Math.random() < 0.30
  if (fail) return ctx.reply('真可惜，娶老婆失败了，嘤嘤嘤。')

  // 自己若已绑定对象（当前群）
  if (hasPartner(couples, uid)) {
    const i1 = findByMan(couples, uid)
    const i2 = findByWoman(couples, uid)
    if (i1 !== -1) {
      const t = couples[i1].woman
      return ctx.reply([
        segment.at(uid), '\n你今天已经有老婆啦 ',
        segment.image(avatarUrl(t)), names[i1].woman || toStr(t), `(${toStr(t)})`,
        '\n别三心二意了！好好珍惜她！'
      ])
    }
    if (i2 !== -1) {
      const t = couples[i2].man
      return ctx.reply([
        segment.at(uid), '\n你今天已经被娶走啦 ',
        segment.image(avatarUrl(t)), names[i2].man || toStr(t), `(${toStr(t)})`,
        '\n别三心二意了！好好珍惜他！'
      ])
    }
  }

  // 拉取群成员并随机（当前群）
  try {
    let mmap = await ctx.group?.getMemberMap?.()
    let list
    if (mmap?.size) {
      list = Array.from(mmap.values())
    } else if (ctx.group?.getMemberList) {
      list = await ctx.group.getMemberList()
    } else {
      list = ctx.group?.members || []
    }

    list = (list || [])
      .map(m => ({
        id: m.user_id ?? m.userId ?? m.id ?? m.uid,
        card: m.card,
        nickname: m.nickname ?? m.name ?? m.user_name,
        is_bot: m.is_bot ?? m.bot ?? false
      }))
      .filter(m => !sameId(m.id, uid) && !m.is_bot)

    if (!list.length) return ctx.reply('群里好冷清，没法随机…')

    const n = Math.floor(Math.random() * list.length)
    const chosen = list[n]

    if (hasPartner(couples, chosen.id)) {
      return ctx.reply('对方今天已经名花（草）有主啦，换个目标~')
    }

    const manName   = ctx.member?.card || ctx.sender?.card || ctx.nickname || toStr(uid)
    const womanName = chosen.card || chosen.nickname || await getMemberName(ctx, getGid(ctx), chosen.id, mmap) || toStr(chosen.id)

    couples.push({ man: uid, woman: chosen.id, createdAt: Date.now() })
    names.push({ man: manName, woman: womanName })

    return ctx.reply([
      segment.at(uid), '\n你今天的老婆是 ',
      segment.image(avatarUrl(chosen.id)),
      womanName, `(${toStr(chosen.id)})`,
      '\n看好她哦，别让她被抢走了。'
    ])
  } catch (err) {
    logger.warn('[娶群友] 获取群成员失败：', err?.message || err)
    return ctx.reply('咳…群成员列表拉不到，换个姿势再试试。')
  }
}, { name: '娶群友（随机）' })

/** ========== 可选：全局定时清理任务（每30分钟清理一次各群过期婚姻） ========== */
export const taskAutoCleanup = karin.task('婚姻过期清理', '*/30 * * * *', async () => {
  let total = 0
  for (const [gid, data] of GROUPS.entries()) {
    total += cleanupGroupExpired(gid, data)
  }
  if (total) logger.info?.(`[marry-cleanup] periodic removed total=${total}`)
}, { log: true, name: '婚姻过期清理' })
