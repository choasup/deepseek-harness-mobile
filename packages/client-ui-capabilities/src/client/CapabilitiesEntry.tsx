import { useCallback, useEffect, useRef, useState } from 'react'
import { cls } from './styles.ts'

/**
 * 输入条上的 ⊕ 与它弹出的能力菜单。
 *
 * 点条目**只填草稿、不自动发送**：一次点击就触发模型调用是意外行为，也会
 * 白花一次请求。填进去让用户看一眼再发——他还可以在发之前补一句要求。
 */

interface InputActions {
  setDraft(text: string): void
}

interface Props {
  /** 由坑位的 owner share 注入（InputZone）。 */
  inputActions?: InputActions
}

/** 一项能力：图标 + 名字 + 点下去往草稿里填的话。 */
interface Capability {
  id: string
  label: string
  hint: string
  draft: string
  icon: () => React.ReactElement
}

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 8.5h3l1.4-2.2h7.2L17 8.5h3a1 1 0 011 1v8a1 1 0 01-1 1H4a1 1 0 01-1-1v-8a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.2" r="3.1" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  )
}

function SensorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <path
        d="M7.8 7.8a6 6 0 000 8.4M16.2 16.2a6 6 0 000-8.4M5 5a9.5 9.5 0 000 14M19 19a9.5 9.5 0 000-14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

/**
 * 只有背后**确实有工具**的能力才出现在这里。
 * 相机 → `take_photo`；传感器 → `read_device_sensors` / `list_device_sensors`。
 */
const CAPABILITIES: Capability[] = [
  {
    id: 'camera',
    label: '拍照',
    hint: '调起相机，把看到的东西给它',
    draft: '拍一张照片，然后告诉我你看到了什么',
    icon: CameraIcon,
  },
  {
    id: 'sensors',
    label: '传感器',
    hint: '型号、电量、姿态、气压、定位',
    draft: '读一下设备传感器，说说现在的状态',
    icon: SensorIcon,
  },
]

export function CapabilitiesEntry({ inputActions }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)

  // 点外面收起。用 pointerdown 而不是 click：后者在 iOS 上有 300ms 的历史
  // 包袱，而且滚动开始时不会触发，菜单会赖在屏幕上。
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const pick = useCallback(
    (capability: Capability) => {
      setOpen(false)
      // 拿不到 inputActions 时**什么都不做**，而不是假装成功：这个坑位的
      // owner share 由 dsh 注入，缺了它说明契约变了，静默填空更难查。
      inputActions?.setDraft(capability.draft)
    },
    [inputActions],
  )

  return (
    <div className={cls.root} ref={root}>
      <button
        type="button"
        className={cls.trigger}
        aria-label="手机能力"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {/*
          **不能用加号。** dsh 自带的"命令"按钮就在左边一格，画的也是一个加号；
          两个几乎一样的 + 并排，用户分不出哪个是哪个（在 375 宽的屏上实测确认）。
          设计稿写的是 ⊕，但设计稿里没有那个自带按钮。
          换成"手机 + 感应波"：这一格下面挂的是相机和传感器，都是"设备去感知
          外面的世界"，图形上跟加号没有任何相似处。
        */}
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect
            x="4.5"
            y="3"
            width="10"
            height="18"
            rx="2.2"
            stroke="currentColor"
            strokeWidth="1.7"
            fill="none"
          />
          <path
            d="M17.6 9.2a4.2 4.2 0 010 5.6M20.2 6.6a7.8 7.8 0 010 10.8"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>

      {open ? (
        <div className={cls.menu} role="menu">
          {CAPABILITIES.map((capability) => {
            const Icon = capability.icon
            return (
              <button
                key={capability.id}
                type="button"
                role="menuitem"
                className={cls.item}
                onClick={() => pick(capability)}
              >
                <span className={cls.itemIcon}>
                  <Icon />
                </span>
                <span className={cls.itemText}>
                  <span className={cls.itemLabel}>{capability.label}</span>
                  <span className={cls.itemHint}>{capability.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
