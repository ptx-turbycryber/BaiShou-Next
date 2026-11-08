import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as fsp from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logger } from '@baishou/shared'

export const TRAY_PREFERENCES_FILE = 'device_tray_prefs.json'

/** 托盘行为偏好（桌面端设备本地设置，不参与增量同步） */
export interface TrayPreferences {
  /** 点关闭按钮时收进托盘，而不是退出程序 */
  closeToTray: boolean
  /** 点最小化按钮时收进托盘 */
  minimizeToTray: boolean
  /** 首次收进托盘时弹一次气泡提示 */
  balloonHint: boolean
}

export const DEFAULT_TRAY_PREFERENCES: TrayPreferences = {
  closeToTray: true,
  minimizeToTray: false,
  balloonHint: true
}

function prefsPath(): string {
  return join(app.getPath('userData'), TRAY_PREFERENCES_FILE)
}

function normalizePrefs(value: unknown): TrayPreferences {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<TrayPreferences>
  return {
    closeToTray:
      typeof raw.closeToTray === 'boolean' ? raw.closeToTray : DEFAULT_TRAY_PREFERENCES.closeToTray,
    minimizeToTray:
      typeof raw.minimizeToTray === 'boolean'
        ? raw.minimizeToTray
        : DEFAULT_TRAY_PREFERENCES.minimizeToTray,
    balloonHint:
      typeof raw.balloonHint === 'boolean' ? raw.balloonHint : DEFAULT_TRAY_PREFERENCES.balloonHint
  }
}

async function readPrefs(): Promise<TrayPreferences> {
  try {
    const raw = await fsp.readFile(prefsPath(), 'utf-8')
    return normalizePrefs(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_TRAY_PREFERENCES }
  }
}

async function writePrefs(prefs: TrayPreferences): Promise<void> {
  try {
    await fsp.mkdir(app.getPath('userData'), { recursive: true })
    await fsp.writeFile(prefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
  } catch (e) {
    logger.warn('[TrayService] ⚠️ 保存托盘偏好失败: ' + String(e))
  }
}

/**
 * 系统托盘服务（桌面端）
 *
 * 目的：让白守可以常驻托盘而不长期占用任务栏。关闭/最小化按钮的行为可在托盘右键菜单里切换，
 * 真实退出只走托盘菜单的「退出白守」（或系统注销/关机，由 before-quit 放行）。
 */
export class TrayService {
  private tray: Tray | null = null
  private prefs: TrayPreferences = { ...DEFAULT_TRAY_PREFERENCES }
  private isQuitting = false
  private balloonShown = false

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly iconPath: string
  ) {}

  async start(): Promise<void> {
    try {
      this.prefs = await readPrefs()
      this.ensureTray()
      this.bindWindowEvents()
      app.on('before-quit', () => {
        this.isQuitting = true
      })
      logger.info('[TrayService] ✅ 托盘服务已启动')
    } catch (e: any) {
      logger.error('[TrayService] ❌ 托盘服务启动失败:', e)
    }
  }

  destroy(): void {
    this.isQuitting = true
    try {
      this.tray?.destroy()
    } catch {
      /* 托盘已被系统回收 */
    }
    this.tray = null
  }

  private resolveIcon(): string {
    if (existsSync(this.iconPath)) return this.iconPath
    // asar 内图标被 unpack 时，退回 unpacked 路径
    const unpacked = this.iconPath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1')
    if (existsSync(unpacked)) return unpacked
    return this.iconPath
  }

  private ensureTray(): void {
    if (this.tray) return
    const image = nativeImage.createFromPath(this.resolveIcon())
    const trayImage = image.isEmpty() ? image : image.resize({ width: 32, height: 32 })
    this.tray = new Tray(trayImage)
    this.tray.setToolTip('白守 — 双击显示窗口')
    this.tray.on('click', () => this.showWindow())
    this.tray.on('double-click', () => this.showWindow())
    this.tray.on('right-click', () => this.rebuildMenu())
    this.rebuildMenu()
  }

  private rebuildMenu(): void {
    if (!this.tray) return
    const visible = this.isWindowVisible()
    const template: MenuItemConstructorOptions[] = [
      {
        label: visible ? '隐藏白守窗口' : '显示白守窗口',
        click: () => (visible ? this.hideWindow() : this.showWindow())
      },
      { type: 'separator' },
      {
        label: '关闭按钮收进托盘（不退出）',
        type: 'checkbox',
        checked: this.prefs.closeToTray,
        click: (item) => void this.patchPrefs({ closeToTray: item.checked })
      },
      {
        label: '最小化按钮收进托盘',
        type: 'checkbox',
        checked: this.prefs.minimizeToTray,
        click: (item) => void this.patchPrefs({ minimizeToTray: item.checked })
      },
      {
        label: '收进托盘时给一次气泡提示',
        type: 'checkbox',
        checked: this.prefs.balloonHint,
        click: (item) => {
          if (!item.checked) this.balloonShown = true
          void this.patchPrefs({ balloonHint: item.checked })
        }
      },
      { type: 'separator' },
      { label: '退出白守', click: () => this.quitApp() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private async patchPrefs(patch: Partial<TrayPreferences>): Promise<void> {
    this.prefs = { ...this.prefs, ...patch }
    await writePrefs(this.prefs)
    this.rebuildMenu()
  }

  private bindWindowEvents(): void {
    const win = this.mainWindow

    win.on('close', (event) => {
      if (this.isQuitting) return
      if (this.prefs.closeToTray) {
        event.preventDefault()
        this.hideWindow()
        return
      }
      logger.info('[TrayService] 关闭按钮放行：程序即将退出')
    })

    win.on('minimize', () => {
      if (this.isQuitting) return
      if (this.prefs.minimizeToTray) {
        // Electron 的 minimize 事件不可取消：最小化后立即隐藏，效果等同收进托盘
        this.hideWindow()
      }
    })

    win.on('show', () => this.rebuildMenu())
    win.on('hide', () => this.rebuildMenu())
    win.on('restore', () => this.rebuildMenu())
  }

  private isWindowAlive(): boolean {
    return !this.mainWindow.isDestroyed()
  }

  private isWindowVisible(): boolean {
    return this.isWindowAlive() && this.mainWindow.isVisible()
  }

  private showWindow(): void {
    if (!this.isWindowAlive()) return
    if (this.mainWindow.isMinimized()) this.mainWindow.restore()
    this.mainWindow.show()
    this.mainWindow.focus()
    this.rebuildMenu()
  }

  private hideWindow(): void {
    if (!this.isWindowAlive()) return
    this.mainWindow.hide()
    this.rebuildMenu()
    this.showBalloonOnce()
  }

  private showBalloonOnce(): void {
    if (!this.prefs.balloonHint || this.balloonShown || !this.tray) return
    if (process.platform !== 'win32') return
    this.balloonShown = true
    try {
      this.tray.displayBalloon({
        title: '白守',
        content: '已收进系统托盘，双击托盘图标可恢复窗口。'
      })
    } catch {
      /* 部分系统/主题不支持气泡，忽略 */
    }
  }

  private quitApp(): void {
    this.isQuitting = true
    this.destroy()
    app.quit()
  }
}
