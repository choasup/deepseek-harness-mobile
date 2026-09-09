/**
 * 给 bundle 里的 `dsh-attachment-local` 打一个补丁：目录 fsync 走到 app 沙盒
 * 外面时，跳过而不是让整次写入失败。
 *
 * ## 为什么非打不可
 *
 * 附件落盘时 dsh 会证明目录项是持久的：
 *
 *     ensureDurableHome(home) → ensureDurableDirectory(home, parse(home).root)
 *
 * 边界是 `parse(home).root`，也就是 **`/`**。于是它从 DSH_HOME 一路往上，
 * 对**每一级祖先**开一个只读句柄并 fsync。在 macOS/Linux 上没问题；在 iOS 上
 * 走到容器上面一层就被沙盒拦下：
 *
 *     Error: EPERM: operation not permitted,
 *            open '/var/mobile/Containers/Data/Application'
 *
 * 表现是"拍照失败"，而错误信息里一个字都没提相机或图像。
 *
 * ## 为什么改这里是对的，而不只是绕过
 *
 * 那个 walk 要保证的是"崩溃后目录项还在"。容器**里面**的目录是我们建的，
 * 该 fsync，也 fsync 得了；容器**外面**的是 iOS 建的、iOS 管的，我们既碰不到
 * 也不负责。为一件本就不属于我们的事让整次写入失败是错的。
 * 所以只吞 EPERM/EACCES——**权限之外的错误照样抛**。
 *
 * ## 为什么是构建期打补丁而不是运行期猴补丁
 *
 * 运行期要改的是 ESM 内部函数，够不着；改全局的 `fs.open` 又会波及所有调用方。
 * 构建期替换一段确定的文本，作用面正好是这一个函数。
 *
 * 代价是 dsh 升级后这段文本可能对不上——所以**找不到锚点就直接失败**，
 * 而不是静默跳过。静默跳过的话，下次只会又收到一句"拍照失败"。
 */
import { readFile, writeFile } from 'node:fs/promises'

const ANCHOR = `	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}`

const REPLACEMENT = `	// dsh-mobile(iOS): 沙盒外的目录我们既打不开也不负责其持久性，
	// 跳过而不是让整次写入失败。权限之外的错误照抛。
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY);
	} catch (error) {
		if (error?.code === "EPERM" || error?.code === "EACCES") return;
		throw error;
	}
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}`

const target = process.argv[2]
if (target === undefined) {
  console.error('用法: node patch-ios-attachment-durability.mjs <dsh-attachment-local/lib/index.js>')
  process.exit(1)
}

const source = await readFile(target, 'utf8')

if (source.includes('dsh-mobile(iOS)')) {
  console.log('attachment 持久化补丁：已经打过了')
  process.exit(0)
}

const occurrences = source.split(ANCHOR).length - 1
if (occurrences !== 1) {
  console.error(
    `attachment 持久化补丁：锚点匹配到 ${occurrences} 处（期望 1 处）。\n` +
      `dsh 大概升级过，syncDirectory 的实现变了。\n` +
      `**不要绕过这个错误**：不打这个补丁，iOS 上每一次存图都会以\n` +
      `"EPERM ... open '/var/mobile/Containers/Data/Application'" 失败，\n` +
      `而报到用户那里的是一句和文件系统毫无关系的"拍照失败"。\n` +
      `去 ${target} 里看 syncDirectory 现在长什么样，把 ANCHOR 更新掉。`,
  )
  process.exit(1)
}

await writeFile(target, source.replace(ANCHOR, REPLACEMENT))
console.log('attachment 持久化补丁：已打上（目录 fsync 遇 EPERM/EACCES 时跳过）')
