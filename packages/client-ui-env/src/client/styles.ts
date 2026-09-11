/**
 * 这个包自己的样式。手写类名 + 一次性注入 <style>，与 dsh 编译产物同形。
 * 颜色一律走 --dsw-* 设计令牌，深浅色跟随全局主题。
 */
export const cls = {
  page: 'dshe-page',
  scroll: 'dshe-scroll',
  section: 'dshe-section',
  sectionTitle: 'dshe-section-title',
  card: 'dshe-card',
  cardHead: 'dshe-card-head',
  cardTitle: 'dshe-card-title',
  badge: 'dshe-badge',
  cardDetail: 'dshe-card-detail',
  members: 'dshe-members',
  member: 'dshe-member',
  memberId: 'dshe-member-id',
  memberState: 'dshe-member-state',
  search: 'dshe-search',
  count: 'dshe-count',
  center: 'dshe-center',
  errorTitle: 'dshe-error-title',
  errorBody: 'dshe-error-body',
  button: 'dshe-button',
} as const

const CSS = `
.dshe-page {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dshe-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 16px 24px;
}

.dshe-section { margin-top: 18px; }
.dshe-section:first-child { margin-top: 4px; }

.dshe-section-title {
  margin: 0 0 8px 2px;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-caption);
}

.dshe-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 10px;
  background: var(--dsw-alias-bg-base);
}

.dshe-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshe-card-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* 状态用**文字**而不是只用颜色：红绿点对色觉障碍不可读，
   而这一屏的全部价值就是"看一眼知道行不行"。 */
.dshe-badge {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-l1);
  color: var(--dsw-alias-label-caption);
}

.dshe-badge[data-ready='true'] {
  background: color-mix(in srgb, var(--dsw-alias-button-info-fill) 14%, transparent);
  color: var(--dsw-alias-button-info-fill);
}

.dshe-card-detail {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--dsw-alias-label-caption);
}

.dshe-members {
  margin-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.dshe-member {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  font-size: 12px;
}

.dshe-member-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshe-member-state {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
}

.dshe-search {
  width: 100%;
  box-sizing: border-box;
  height: 40px;
  padding: 0 12px;
  margin-bottom: 8px;
  border: none;
  border-radius: 12px;
  background: var(--dsw-alias-bg-l1);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
}

.dshe-count {
  margin: 0 0 8px 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-caption);
}

.dshe-center {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 32px;
  text-align: center;
}

.dshe-error-title {
  margin: 0;
  font-size: 17px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.dshe-error-body {
  margin: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--dsw-alias-label-caption);
  overflow-wrap: anywhere;
}

.dshe-button {
  min-height: 44px;
  padding: 0 20px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  cursor: pointer;
}
`

export function installStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-mobile/client-ui-env/env.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-mobile/client-ui-env'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}
