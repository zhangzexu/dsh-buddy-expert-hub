/**
 * dsh-buddy-expert-hub — 连接器凭据的本地加密存储。
 *
 * 为什么不写环境变量：`setx` / `~/.profile` 都是平台相关且污染系统环境，
 * Linux/macOS 行为不一致。这里改成**跨平台本地加密文件**：
 *
 *   $DSH_HOME/dsh-buddy-expert-hub/credentials.enc
 *   { v, salt, iv, tag, data }   —— AES-256-GCM，密钥由「机器标识 + 用户标识 + 随机 salt」
 *                                   经 SHA-256 派生；文件权限 0600（Windows 只依赖目录 ACL）。
 *
 * 配置文件（cordis.patch.yml）里**不出现任何明文**，只写一行自包含的解密表达式
 * （`process.getBuiltinModule("fs"|"crypto"|"os")`，Node 22+ 内置，无需 require）。
 *
 * **安全边界（必须如实告知）**：主密钥材料是 `hostname + username`，同机同用户的
 * 进程理论上都能派生并解密。它能防的是「配置文件被分享/提交/备份泄露」和肩窥，
 * 不等于 OS 级密钥库（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 要更强只能引入原生密钥库依赖，本插件坚持零依赖。
 *
 * @module dsh-buddy-expert-hub/connector-secret
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 加密文件名。 */
export const SECRET_FILE_NAME = 'credentials.enc'

/** 载荷版本。 */
const PAYLOAD_VERSION = 1

/**
 * 加密文件绝对路径。
 * @param {string} baseDir 插件数据目录
 * @returns {string} 文件路径
 */
export function secretFilePath(baseDir) {
  return path.join(baseDir, SECRET_FILE_NAME)
}

/**
 * 主密钥材料：机器 + 用户。两端（加密与配置表达式）必须完全一致。
 * @returns {string} 材料串
 */
function masterMaterial() {
  let user = 'unknown'
  try { user = os.userInfo().username } catch { /* 容器里可能取不到 */ }
  return os.hostname() + '|' + user
}

/**
 * 由 salt 派生 32 字节密钥。
 * @param {string} saltHex 十六进制 salt
 * @returns {Buffer} 密钥
 */
function deriveKey(saltHex) {
  return createHash('sha256').update(masterMaterial() + '|' + saltHex).digest()
}

/**
 * 读取并解密全部凭据；文件缺失/损坏/密钥不匹配一律返回空对象，绝不抛错。
 * @param {string} baseDir 插件数据目录
 * @returns {Record<string, string>} 变量名到值的映射
 */
export function readSecrets(baseDir) {
  const file = secretFilePath(baseDir)
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (payload === null || typeof payload !== 'object' || payload.v !== PAYLOAD_VERSION) return {}
    const key = deriveKey(String(payload.salt || ''))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(payload.iv || ''), 'base64'))
    decipher.setAuthTag(Buffer.from(String(payload.tag || ''), 'base64'))
    const text = Buffer.concat([
      decipher.update(Buffer.from(String(payload.data || ''), 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') out[name] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 合并写入凭据（空值表示删除该键），整文件重新加密。
 *
 * @param {string} baseDir 插件数据目录
 * @param {Record<string, string>} patch 新值（空串删除）
 * @returns {{ file: string, keys: string[] }} 文件路径与当前含有的变量名
 */
export function saveSecrets(baseDir, patch) {
  const merged = Object.assign({}, readSecrets(baseDir))
  for (const [name, value] of Object.entries(patch)) {
    const text = typeof value === 'string' ? value : ''
    if (text.trim() === '') delete merged[name]
    else merged[name] = text
  }
  const salt = randomBytes(16).toString('hex')
  const key = deriveKey(salt)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(merged), 'utf8'), cipher.final()])
  const payload = {
    v: PAYLOAD_VERSION,
    salt,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  fs.mkdirSync(baseDir, { recursive: true })
  const file = secretFilePath(baseDir)
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 无 POSIX 位，忽略 */ }
  return { file, keys: Object.keys(merged).sort() }
}

/**
 * 生成读取单个凭据的 `!!js` 表达式（自包含，不依赖插件目录，插件移动也不失效）。
 *
 * 与 {@link readSecrets} 用完全相同的 KDF 与密文格式；两边必须同步修改，
 * 由 smoke24 的端到端断言（写入后表达式求值取回原值）兜住。
 *
 * @param {string} name 变量名
 * @param {string} baseDir 插件数据目录
 * @returns {string} 可直接放进 `!!js` 的表达式
 */
export function buildSecretExpr(name, baseDir) {
  const file = secretFilePath(baseDir)
  const q = (value) => JSON.stringify(String(value))
  return '(function(){' +
    'var f=process.getBuiltinModule("fs"),c=process.getBuiltinModule("crypto"),o=process.getBuiltinModule("os");' +
    'var j=JSON.parse(f.readFileSync(' + q(file) + ',"utf8"));' +
    'var u="unknown";try{u=o.userInfo().username}catch(e){}' +
    'var k=c.createHash("sha256").update(o.hostname()+"|"+u+"|"+j.salt).digest();' +
    'var d=c.createDecipheriv("aes-256-gcm",k,Buffer.from(j.iv,"base64"));' +
    'd.setAuthTag(Buffer.from(j.tag,"base64"));' +
    'return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data,"base64")),d.final()]).toString())[ ' + q(name) + ' ]' +
    '})()'
}

export default { readSecrets, saveSecrets, secretFilePath, buildSecretExpr, SECRET_FILE_NAME }
