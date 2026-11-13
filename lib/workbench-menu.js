/**
 * dsh-buddy-expert-hub — 工作台 HTML 内嵌菜单声明的提取与校验。
 * 只读字符串切片，绝不执行 HTML；单个文件声明非法不影响其它工作台。
 * @module dsh-buddy-expert-hub/workbench-menu
 */
const DECLARATION_RE = /<script[^>]*type\s*=\s*["']application\/json["'][^>]*id\s*=\s*["']workbench-menu["'][^>]*>([\s\S]*?)<\/script>/i
const ALT_RE = /<script[^>]*id\s*=\s*["']workbench-menu["'][^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const FILE_RE = /^[A-Za-z0-9._-]+\.csv$/
const KEY_RE = /^[A-Za-z0-9_]+$/
const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum']

export const MENU_DECLARATION_ID = 'workbench-menu'

/** 从 HTML 文本中提取并校验菜单声明。 @returns {{menu: object|null, error: string}} */
export function extractMenu(htmlText) {
  const text = String(htmlText === null || htmlText === undefined ? '' : htmlText)
  const match = DECLARATION_RE.exec(text) || ALT_RE.exec(text)
  if (match === null) {
    return { menu: null, error: '缺少 <script type="application/json" id="workbench-menu"> 菜单声明' }
  }
  let parsed
  try { parsed = JSON.parse(match[1]) } catch (error) {
    return { menu: null, error: '菜单声明不是合法 JSON：' + String((error && error.message) || error) }
  }
  const checked = validateMenu(parsed)
  if (checked.errors.length > 0) return { menu: null, error: checked.errors.join('；') }
  return { menu: checked.menu, error: '' }
}

/** 白名单校验 + 归一化。 */
export function validateMenu(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { menu: null, errors: ['菜单声明必须是 JSON 对象'] }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id 需为小写字母/数字/连字符，长度 1-64')
  if (typeof raw.name !== 'string' || raw.name.trim() === '') errors.push('name 不能为空')
  const tables = Array.isArray(raw.tables) ? raw.tables : []
  if (tables.length === 0) errors.push('tables 至少需要 1 张表')

  const cleanTables = []
  tables.forEach((table, idx) => {
    if (table === null || typeof table !== 'object') { errors.push('tables[' + idx + '] 不是对象'); return }
    if (typeof table.file !== 'string' || !FILE_RE.test(table.file)) errors.push('tables[' + idx + '].file 只能是无路径的 .csv 文件名')
    const fields = Array.isArray(table.fields) ? table.fields : []
    if (fields.length === 0) errors.push('tables[' + idx + '].fields 不能为空')

    const seen = new Set()
    const cleanFields = []
    fields.forEach((field) => {
      if (field === null || typeof field !== 'object') return
      if (typeof field.key !== 'string' || !KEY_RE.test(field.key)) { errors.push('字段 key 非法'); return }
      if (seen.has(field.key)) { errors.push('字段 key 重复：' + field.key); return }
      seen.add(field.key)
      cleanFields.push({
        key: field.key,
        label: typeof field.label === 'string' ? field.label : field.key,
        type: FIELD_TYPES.indexOf(field.type) >= 0 ? field.type : 'string',
        required: field.required === true,
        default: field.default === undefined || field.default === null ? '' : String(field.default),
        options: Array.isArray(field.options) ? field.options.map(String) : []
      })
    })
    if (!seen.has('_id')) {
      cleanFields.unshift({ key: '_id', label: 'ID', type: 'string', required: true, default: '', options: [] })
    }
    cleanTables.push({
      file: typeof table.file === 'string' ? table.file : '',
      fields: cleanFields,
      keys: cleanFields.map((f) => f.key)
    })
  })

  const rawItems = Array.isArray(raw.menu) ? raw.menu : []
  const items = rawItems.map((item, idx) => ({
    id: item !== null && typeof item.id === 'string' ? item.id : 'item-' + String(idx + 1),
    label: item !== null && typeof item.label === 'string' ? item.label : '总览',
    view: item !== null && typeof item.view === 'string' ? item.view : '',
    prompt: item !== null && typeof item.prompt === 'string' ? item.prompt : ''
  }))
  if (items.length === 0) items.push({ id: 'overview', label: '总览', view: '', prompt: '' })

  return {
    errors,
    menu: {
      version: typeof raw.version === 'number' ? raw.version : 1,
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      icon: typeof raw.icon === 'string' ? raw.icon : '',
      tables: cleanTables,
      menu: items,
    }
  }
}

export default { extractMenu, validateMenu, MENU_DECLARATION_ID }
