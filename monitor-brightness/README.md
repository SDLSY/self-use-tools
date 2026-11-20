# 显示器亮度

Windows 10 / 11 免安装托盘工具，使用系统自带的 .NET Framework 4.x。无第三方运行库、网络服务或管理员权限要求。

## 使用

双击本目录的 **MonitorBrightness.exe**。点击任务栏通知区域的蓝色显示器图标，打开面板；若图标被收纳，可从通知区域的“显示隐藏图标”中找到，也可拖到任务栏。

- 每个可读取亮度的显示器对应一个 0–100% 滑块，名称尽量使用显示器报告的品牌和型号。
- 拖动滑块可调节实际背光，频繁请求会合并；松开鼠标或键盘按键会立即提交最终值。滑块聚焦后也支持方向键。
- 启动和刷新只读取当前值，不会覆盖显示器设置。调整结果由显示器保留。
- 点击其他窗口或关闭面板，只收起面板。托盘右键可“刷新显示器”或“退出”。再次双击 EXE 会打开已有进程的面板。
- 不可读取 DDC/CI 的屏幕（通常包括内置屏）不显示滑块。拔插、休眠唤醒或控制失败后可刷新恢复。
- 错误后滑块会停用，显示最近读回的硬件亮度；悬停错误文字可查看详细原因。

当前版本只提供手动调节，不含自动亮度、定时、快捷键和开机自启。

## DDC/CI 排查

1. 在显示器自身的菜单中开启 DDC/CI，并点击“刷新显示器”。
2. 尽量直连 HDMI / DisplayPort；部分扩展坞、转接器、KVM 或显示驱动不传递 DDC/CI。
3. 若能够读取却提示“显示器未应用亮度”，检查显示器的 DCR / 动态对比度、HDR、节能或游戏预设是否锁定背光；也可在显示器菜单中手动调整亮度后刷新，确认读数是否变化。
4. 退出可能同时控制亮度的其他工具；检查连接、更新显卡驱动，或给显示器断电重启后刷新。

接口返回成功不代表背光确实变化，本程序会延迟重读并核验；高层写入无效时会尝试 VCP 0x10。若硬件仍拒绝设置，会明确报错，不会显示虚假的成功值。

**本机验证限制（2026-11-13）：** AOC Q27N3G5R4 可读到 70/100，但测试写入 68、71、72 后仍返回 70，高层接口和 VCP 0x10 都未能确认改变。Windows HDR 当时未开启；具体显示器模式/链路原因尚未确定。界面和错误恢复已验证，真实亮度调整在此屏上尚未通过。测试结束读数为 70，详见 [验证记录](VERIFICATION.md)。

## 构建

在本目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

使用 Windows 自带的 .NET Framework C# 编译器，输出根目录 `MonitorBrightness.exe`。构建前请从托盘退出已有程序。`src/` 包含全部源代码和 Windows 清单；可以复制整个文件夹，也可以单独复制 EXE 使用。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-smoke.ps1
```

先退出运行中的正式程序。此测试使用真实显示器，最多在原值附近调整 1%，并在 `finally` 中恢复原值。测试覆盖托盘事件、滑块、快速连续变化、刷新、失焦收起和退出，生成 `tests/panel.png`。退出码 0 表示界面及硬件写入均通过，3 表示界面通过但硬件拒绝应用亮度，其他非零表示失败。模拟断开测试只检验错误界面；实际拔插需人工验证。

`tests/check-single-instance.ps1` 检验正式 EXE 的重复启动和面板关闭；真实托盘和物理拔插的人工复验步骤见 `tests/manual-checks.md`。

## 实现与参考

C# / WinForms，单后台线程串行调用 Windows `dxva2.dll`；刷新和退出时释放物理显示器句柄。无需下载安装依赖，没有远程接口。

选型时检索了 [Twinkle Tray](https://github.com/xanderfrangos/twinkle-tray) 和 [Win10 BrightnessSlider](https://github.com/blackholeearth/Win10_BrightnessSlider)。当前环境 GitHub API 返回 403，raw 下载超时，未引入或复制这些项目的代码；本项目按轻量 .NET Framework 方案独立实现。
