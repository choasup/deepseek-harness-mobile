/**
 * 这个包自己的样式。
 *
 * 手写类名 + 一次性注入 <style>，跟 dsh 编译产物的做法一致（它用的是 CSS
 * modules，构建期生成同样形状的注入代码）。用 `dshm-` 前缀避免跟别的插件撞。
 *
 * 颜色一律走 `--dsw-*` 设计令牌，不写死——那些变量由 theme-presenter 写在
 * body 上，跟其余 32 个 UI 插件用的是同一套，所以深浅色跟随全局主题。
 */
export const cls = {
  frame: 'dshm-frame',
  topbar: 'dshm-topbar',
  backButton: 'dshm-back',
  pageTitle: 'dshm-page-title',
  center: 'dshm-center',
  tabPage: 'dshm-tabpage',
  tabbar: 'dshm-tabbar',
  tabItem: 'dshm-tab',
  tabLabel: 'dshm-tab-label',
  scrim: 'dshm-scrim',
  sheet: 'dshm-sheet',
  sheetGrip: 'dshm-sheet-grip',
  sheetBody: 'dshm-sheet-body',
  overlay: 'dshm-overlay',
  sidebar: 'dshm-sidebar',
  newSession: 'dshm-new-session',
  sidebarBody: 'dshm-sidebar-body',
  sidebarFoot: 'dshm-sidebar-foot',
  emptyTab: 'dshm-empty',
  emptyTitle: 'dshm-empty-title',
  emptyHint: 'dshm-empty-hint',
} as const

const CSS = `
.dshm-frame {
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
}

/* 顶栏。桌面版没有这个东西——侧栏收起后靠一条 56px 常驻控制条提供入口，
   而手机上那条竖栏纯属浪费宽度，所以改成顶部一个菜单键。 */
.dshm-topbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  /* 设计稿：padding 56px 12px 10px。56 里含状态栏，所以用安全区变量兜住
     刘海与灵动岛，env() 拿不到时退回 56-12=44 的近似值。 */
  padding: calc(env(safe-area-inset-top, 12px) + 12px) 12px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}

/* 返回键与 Tab 项一样按 44×44 的触控目标做——iOS HIG 的下限，
   而这一版的核心诉求之一就是"关键操作要够得着"。 */
.dshm-back {
  width: 44px;
  height: 44px;
  margin-left: -10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  border-radius: 12px;
}

/* 页面大标题：28/34 600，字距收紧一点（设计稿 letter-spacing:-.01em）。 */
.dshm-page-title {
  font-size: 28px;
  line-height: 34px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
  padding: 2px 8px 6px;
}

/* **自己写的 display 会覆盖浏览器默认的 [hidden] display:none。**
   下面几个类都设了 display，所以必须显式把 hidden 态压回去——否则
   hidden 属性形同虚设：会话页、两个 Tab 页、Tab 栏会同时渲染，
   而且不报任何错，只是"东西都在页面上"。实测踩过。

   （这段注释里刻意不用反引号：整个 CSS 是一个 TS 模板字符串，
   反引号会把它提前终结，而报错指向的是下一行的语法，很难看出真因。） */
.dshm-center[hidden],
.dshm-tabpage[hidden],
.dshm-tabbar[hidden] {
  display: none !important;
}

.dshm-center,
.dshm-tabpage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 底部 Tab 栏。
   导航放底部是这一版的主张：拇指区在屏幕下半部，而旧版把入口全放在顶栏。
   会话内页会整体隐藏它（[hidden]），底部让给输入条。 */
.dshm-tabbar {
  flex: 0 0 auto;
  display: flex;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  padding: 8px 12px 0;
  /* home indicator 的空间：设计稿给 26px，用安全区兜住没有指示条的机型。 */
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
}

.dshm-tab {
  flex: 1;
  min-height: 44px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 0 6px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--dsw-alias-label-caption);
}

.dshm-tab[data-active='true'] {
  color: var(--dsw-alias-button-info-fill);
}

.dshm-tab-label {
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
}

.dshm-tab[data-active='true'] .dshm-tab-label {
  font-weight: 600;
}

.dshm-sheet {
  position: absolute;
  inset: auto 0 0 0;
  max-height: 76%;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  border-top: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px 14px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
  transform: translateY(100%);
  visibility: hidden;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease),
              visibility 0s linear var(--ds-transition-duration-slow, .24s);
}
.dshm-frame[data-details='open'] .dshm-sheet {
  transform: translateY(0);
  visibility: visible;
  transition: transform var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease);
}

/* 下拉把手：一条横杠，兼作"这里能拖/能点关"的可见提示。 */
.dshm-sheet-grip {
  flex: none;
  height: 28px;
  display: grid;
  place-items: center;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.dshm-sheet-grip::after {
  content: '';
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l3, rgba(127, 127, 127, .5));
}
.dshm-sheet-body { flex: 1 1 auto; min-height: 0; overflow: auto; }

.dshm-scrim {
  position: absolute;
  inset: 0;
  z-index: 25;
  background: rgba(0, 0, 0, .38);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration-slow, .24s) var(--ds-ease-in-out, ease);
}

/* 与桌面版同名同语义的整框浮层：默认穿透，条目自己要回指针事件。 */
.dshm-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}
.dshm-overlay > * { pointer-events: auto; }

/* ── 触屏上关掉悬停提示 ──────────────────────────────────────────────
   桌面版给按钮配了 hover tooltip（"发送消息"那类）。触屏没有"移开指针"
   这个动作：手指点一下，:hover 就**留在**那个元素上不走，于是提示框赖在
   屏幕中间，挡住内容且怎么都不消失。

   hover:none 只匹配真正没有悬停能力的指针设备——桌面完全不受影响，
   带触控板的笔记本也不受影响。

   用 display:none 而不是 opacity:0：后者只是看不见，仍然占据布局、
   仍然拦截点击。 */
@media (hover: none) {
  [role='tooltip'],
  [class*='tooltip'],
  [class*='Tooltip'] {
    display: none !important;
  }

  /* 行内操作在触屏上必须常显。

     dsh 的侧栏把每行的操作放在一个 display:none 的容器里，靠
     \`:hover\` 或 \`.menuOpen\` 放成 inline-flex。触屏**两个条件都不成立**，
     于是手机上重命名、删除会话、在某个工作区里新建会话——全都没有入口，
     按钮实测是 0×0。

     **选择器用结构而不是类名**：那些类名是 CSS-module 哈希
     （YDXeBa_rowActions 这种），dsh 每次构建都会变。而"treeitem 的直接
     子元素、内部含按钮"这个关系稳定得多；实测它精确命中 7 个操作容器，
     行标签、时间戳之类一个都没误伤。

     用 !important 是因为要盖的是别的包的基础规则，而我们无法预知它下次
     构建后的选择器权重。 */
  .dshm-tabpage [role='treeitem'] > :has(button) {
    display: inline-flex !important;
  }

  /* 那些图标按钮是 16×16，对手指太小。行高 34px，撑到 28 是塞得下的上限
     ——HIG 推荐的 44 会把整行挤变形，这里取能做到的最好值而不是照搬数字。 */
  .dshm-tabpage [role='treeitem'] > :has(button) button {
    min-width: 28px;
    min-height: 28px;
  }
}

/* ── 设置对话框的窄屏降级 ────────────────────────────────────────────
   dsh 的设置面板是桌面版两栏：左侧 nav + 右侧内容。在 375px 宽的手机上
   nav 独占 188px，内容只剩 127px——文字变成一个字一行。

   **选择器刻意用结构而不是类名**：那些类名是 CSS-module 哈希
   （VOzbGW_panel 这种），dsh 每次重新构建都会变。而
   [role=dialog] > nav 这种结构关系稳定得多。代价是万一 dsh 改了 DOM 结构
   这段会静默失效（回到挤压的样子，不会坏），可以接受。

   只在窄屏生效，桌面完全不受影响。 */
@media (max-width: 640px) {
  [role='dialog'] {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100dvh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
    flex-direction: column !important;
  }

  /* 左栏变成顶部的横向标签条 */
  [role='dialog'] > nav {
    width: 100% !important;
    flex: none !important;
    border-right: none !important;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    padding-bottom: 4px;
  }
  [role='dialog'] > nav > div:last-child {
    display: flex !important;
    flex-direction: row !important;
    overflow-x: auto !important;
    gap: 4px;
    /* 手机上横滑时不要出现滚动条占位 */
    scrollbar-width: none;
  }
  [role='dialog'] > nav > div:last-child::-webkit-scrollbar { display: none; }
  [role='dialog'] > nav button {
    width: auto !important;
    flex: 0 0 auto !important;
    white-space: nowrap !important;
    /* 44pt 触控目标 */
    min-height: 44px;
  }

  /* 右栏吃满剩余宽度——这一条是"一个字一行"的正解 */
  [role='dialog'] > div {
    width: 100% !important;
    min-width: 0 !important;
    flex: 1 1 auto !important;
    overflow-y: auto !important;
  }
  /* 面板内的行在窄屏下从"标签｜控件"并排改成上下堆叠，
     否则标签被挤成竖排。 */
  [role='dialog'] label,
  [role='dialog'] [class*='row'] {
    min-width: 0 !important;
  }
}

/* ── 手机版侧栏外壳（顶替 dsh 自带的桌面竖栏）──────────────────────── */

/* 通栏，不再有内联写死的 320px。自带外壳在 375 宽的屏上留出 55px 死区，
   那是"桌面组件硬塞进手机"最直观的一处。 */
.dshm-sidebar {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
}

.dshm-new-session {
  flex: 0 0 auto;
  margin: 4px 16px 10px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
}

.dshm-new-session:active {
  background: var(--dsw-alias-bg-l1);
}

.dshm-sidebar-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 设置钉在底部，贴着 Tab 栏上沿。 */
.dshm-sidebar-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding: 4px 8px;
}

/* 会话树本体是照搬的桌面组件，密度按鼠标做的。这里只补触控下限——
   按名字选不到（它的类名是 CSS Modules 哈希，升级 dsh 就会变），
   所以按**角色**选：能点的东西一律 ≥44 高。 */
.dshm-sidebar-body button,
.dshm-sidebar-body [role='button'],
.dshm-sidebar-body [role='treeitem'],
.dshm-sidebar-body a {
  min-height: 44px;
}

/* 图标按钮（搜索、视图选项、添加工作区、每行的 ···）的触控目标靠**伪元素**
   撑开，不改它自己的尺寸。
   直接写 min-width 试过一次，结果是"添加工作区"被挤出屏幕右侧：那三个图标
   装在一个宽度固定 60px 的容器里，按钮一变宽就溢出，而溢出的部分在手机上
   根本点不到——为了做大触控目标反而丢了一个功能。 */
.dshm-sidebar-body button:has(> svg:only-child) {
  position: relative;
}

.dshm-sidebar-body button:has(> svg:only-child)::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

/* 这一层不该横向滚。里面的桌面组件按更宽的视口算过尺寸，
   多出来的几个像素在手机上表现为整页能左右拽。 */
.dshm-sidebar-body > * {
  max-width: 100%;
  overflow-x: hidden;
}

/* "工作区"那一行**按内容宽度撑开**（flex: 0 0 auto），比容器宽 4px——
   行尾多挂着一个零宽的对话框锚点，它自己不占位，却带来一个 4px 的 gap。
   结果是最右边那个"添加工作区"图标被屏幕边缘切掉半个。440pt 的机型上尤其
   明显（375 上只是紧贴边缘，看着还像是设计如此）。
   钉死成容器宽度，中间那格（flex: 1）自己吸收差额；顺带给右边留 8px，
   免得图标贴着屏幕边——那里还有系统的侧滑手势。 */
.dshm-sidebar-body [class*='sectionHeader'] {
  width: 100%;
  box-sizing: border-box;
  padding-right: 8px;
}

/* ── 会话页里溢出的行 ──────────────────────────────────────────────── */

/* 自带的聊天节点按桌面宽度排版，窄屏上整行被切掉右半截。实测："上下文注入 ·
   @deepseek-ai/dsh-system-prompt" 这一行需要 336px，而可用宽度只有 303px，
   后面的包名直接消失——不是省略号，是没了。
   **只让"来源"那一格收缩。** 两种更省事的写法都试过，都更糟：
   - 让行内每一格都能收缩 → "上下文注入"四个字被压成两行并互相叠字，
     标题本来就该按内容宽度占位。
   - 让整行换行 → 行高是固定的 24px，换到第二行的内容直接被裁掉不见，
     比省略号糟得多（用户根本不知道还有东西）。
   选择器按**子串**匹配类名（_row_9cl6j_10 这种是 CSS Modules 的
   「原名_哈希」形状，原名留在前面），比匹配整串哈希稳。
   注意这段在 JS 模板字符串里，不能用反引号。 */
.dshm-center [class*='row'] > [class*='source'] {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 会话页里这一栏只剩一个返回键，右边整片是空的。压薄它：那 20 来个像素
   在 812 高的屏上不算多，但它紧挨着自带会话头（标题 + 对话/轨迹 Tab），
   两条横线叠在一起会让顶部显得很重。去掉分隔线，让它和下面那一行连成一片。 */
.dshm-frame[data-conversation='open'] .dshm-topbar {
  padding-top: calc(env(safe-area-inset-top, 8px) + 6px);
  padding-bottom: 2px;
  border-bottom: none;
}

/* Tab 页的空状态。 */
.dshm-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 40px;
  text-align: center;
}

.dshm-empty-title {
  margin: 0;
  font-size: 17px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.dshm-empty-hint {
  margin: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--dsw-alias-label-caption);
}

@media (prefers-reduced-motion: reduce) {
  .dshm-sheet, .dshm-scrim, .dshm-tabbar { transition: none; }
}
`

/**
 * 注入一次。守卫条件跟 dsh 编译产物一致：按 `data-plugin-css` 查重，
 * 这样插件热重载重复 materialize 时不会堆出一摞 <style>。
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-mobile/client-ui-layout-mobile/frame.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-mobile/client-ui-layout-mobile'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}
