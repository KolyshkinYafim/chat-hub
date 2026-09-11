# Chat Hub на Arch / CachyOS

**Проверено:** 2026-08-27, `main` `5883232`. Живой прогон на CachyOS, KDE Plasma 6, Wayland,
Node 26.7.0 / pnpm 11.15.1.

**Статус.** Приложение на Linux **запущено и работает**: окно открывается, dev-сервер отдаёт
рендерер, unix-сокеты поднимаются. До этого документа Electron под Linux ни разу не запускали —
CI гоняет `lint`, `typecheck` и тесты на `ubuntu-latest`, но до графики не доходит. Первый живой
прогон вскрыл две вещи, которых по коду видно не было, обе описаны ниже:
[установщик Electron ломается на Node 26](#pnpm-dev-падает-с-error-electron-uninstall) и
[`corepack enable` не проходит без root](#corepack-enable-падает-с-eacces).

Документ решает одну задачу: поднять Hub на CachyOS так, чтобы в нём можно было работать
и его же дорабатывать.

## Подготовка системы

```bash
sudo pacman -S --needed base-devel python nodejs npm
```

`base-devel` и `python` здесь не для галочки. `node-pty` — нативный модуль, и в пакете лежат
префилды только под `darwin-arm64/x64` и `win32-arm64/x64`. Под Linux его нет, значит он будет
собираться из исходников прямо при установке зависимостей. Без компилятора установка упадёт,
а без `node-pty` не поднимется терминал внутри Hub.

**Версия Node критична, и `engines` тут врёт.** В `package.json` стоит `>=20`, в CI — 22, но на
Node 26 установка Electron ломается (см. [ниже](#pnpm-dev-падает-с-error-electron-uninstall)).
Рабочий диапазон — **20–22**. CachyOS ставит из репозиториев самый свежий Node, поэтому версию
для этого проекта надо брать через nvm:

```bash
nvm install 22 && nvm use 22
```

pnpm лучше не ставить из pacman, а взять ту версию, которая записана в `packageManager`. На Arch
`corepack enable` без аргументов падает — Node лежит в `/usr`, и симлинки туда пишутся только от
root. Каталог надо задать явно:

```bash
corepack enable --install-directory ~/.local/bin
corepack prepare pnpm@11.15.1 --activate
```

`~/.local/bin` должен быть в `PATH` раньше `/usr/bin`, иначе продолжит работать pnpm из pacman.

## Установка и запуск

```bash
git clone git@github.com:KolyshkinYafim/chat-hub.git && cd chat-hub && pnpm install && pnpm dev
```

`pnpm dev` — это `electron-vite dev`: собирает main/preload/renderer и поднимает окно с горячей
перезагрузкой. Отдельной сборки для разработки не нужно.

Убедиться, что дерево здоровое, можно тем же набором, что гоняет CI:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Куда лягут данные

Пути уже разведены по платформам в [`src/shared/bridge-path.ts`](../src/shared/bridge-path.ts),
править ничего не надо. На Linux это `~/.local/share/agent-desktop/`. По факту первого запуска
там появляются `commands.jsonl` и два сокета — `hub.sock` и `browser.sock`. `monitor.sock` не
создаётся: его поднимает session-monitor, которого на Linux нет. Настройки и состояние самого приложения
Electron кладёт в `~/.config/chat-hub/` — но **не при `pnpm dev`**: dev-запуск намеренно
уводит `userData` в `~/.config/chat-hub-dev/`, чтобы не делить сессии и запечатанные ключи
с установленным приложением ([`index.ts`](../src/main/index.ts)). Пока работаешь через
`pnpm dev`, смотреть надо в каталог с суффиксом.

Юникс-сокеты на Linux работают штатно. Это стоит проговорить, потому что для Windows они
отдельная и нерешённая проблема — там нужны named pipes, и к Linux это отношения не имеет.

## Агентские CLI

Hub ищет бинарники сначала в `PATH`, потом в списке типовых мест из
[`src/main/adapters/binary.ts`](../src/main/adapters/binary.ts). Из этого списка на Arch
осмысленны `~/.local/bin` и `~/.grok/bin`, а `~/.nvm/versions/node/*/bin` разворачивается
автоматически, если ставил CLI через nvm. `/opt/homebrew/bin` и `/usr/local/bin` там тоже есть —
на Linux они просто ничего не найдут и вреда не сделают.

| Провайдер | Имя бинарника | Дополнительно ищется в |
|---|---|---|
| Claude Code | `claude` | — |
| Codex | `codex` | `~/.codex/bin/`, `~/.local/bin/` |
| Grok | `grok` | `~/.grok/bin/` |
| OpenCode | `opencode` | — |

Логиниться в CLI лучше руками в терминале, а не кнопкой в Hub — почему, ниже.

## Чего на Linux не будет

Ничего из этого не роняет приложение: каждая ветка проверяет доступность и молча отключает
функцию.

**Диктовка.** Завязана на [Handy](https://handy.computer) — это macOS-приложение, путь
захардкожен в [`voice-handy.ts`](../src/main/voice-handy.ts). `handyInstalled()` вернёт `false`,
кнопка микрофона просто не появится.

**Island.** Отдельное приложение session-monitor, написано на Swift, существует только под macOS.
Hub это переживает корректно — если сокета нет, [`permission-broker.ts`](../src/main/permission-broker.ts)
пишет строчку в лог и работает так, как работал до появления Island. Практическое следствие:
запросы разрешений решаются внутри окна Hub, плавающей плашки поверх экрана не будет. Задачи
[#21](https://github.com/KolyshkinYafim/chat-hub/issues/21) и
[#22](https://github.com/KolyshkinYafim/chat-hub/issues/22) на Linux смысла не имеют.

**Кнопка логина в CLI.** [`terminal-launch.ts`](../src/main/terminal-launch.ts) на macOS открывает
Terminal.app через `osascript`, а фолбэк выполняет команду через `sh -c` без окна. Команда
отработает, но интерактивный логин, который просит что-то ввести, ты не увидишь. Отсюда совет
логиниться руками.

## Если не запускается

Ниже — то, что реально случилось при первом прогоне, и то, что ожидалось, но не случилось.
Помечено, где как.

### `pnpm dev` падает с `Error: Electron uninstall`

**Случилось на самом деле.** `pnpm install` проходит без единой ошибки, `node-pty` собирается,
main и preload собираются, dev-сервер поднимается — и на запуске окна всё падает:

```
error during start dev server and electron app:
Error: Electron uninstall
    at getElectronPath (.../electron-vite/dist/chunks/lib-*.mjs)
```

Причина не в pnpm и не в блокировке сборочных скриптов. Postinstall Electron отрабатывает,
zip-архив (`~/.cache/electron/*/electron-v35.7.5-linux-x64.zip`, 110 МБ) скачивается целиком —
но распаковка обрывается молча, с нулевым кодом возврата, и в `dist/` остаётся один каталог
`locales` вместо 74 файлов. `path.txt` не создаётся, `require('electron')` возвращает ошибку
«Electron failed to install correctly».

**Виновата версия Node.** Проверено прямым сравнением на одном и том же кеше:

| Node | Результат `node install.js` |
|---|---|
| 26.7.0 | только `dist/locales`, 0 файлов, exit 0 |
| 22.23.2 | все 74 файла, `dist/electron` 188 МБ, `path.txt` на месте |

Лечение — взять Node из поддерживаемого диапазона и переустановить:

```bash
nvm use 22
pnpm rebuild electron
```

Если Node сменить нельзя, архив уже лежит в кеше и распаковывается руками:

```bash
E=$(find node_modules/.pnpm -maxdepth 3 -type d -name electron -path '*electron@*' | head -1)
Z=$(find ~/.cache/electron -name 'electron-v35.7.5-linux-x64.zip' | head -1)
rm -rf "$E/dist" && mkdir -p "$E/dist" && unzip -q "$Z" -d "$E/dist"
chmod +x "$E/dist/electron"
printf 'electron' > "$E/path.txt"
```

`printf`, а не `echo`: `echo` допишет перевод строки, он попадёт в путь, и запуск свалится в
`ENOENT` на пути, заканчивающемся на `\n`.

### `corepack enable` падает с EACCES

**Случилось на самом деле.** На Arch Node установлен в `/usr`, и corepack пытается класть
симлинки в `/usr/bin`:

```
Internal Error: EACCES: permission denied, symlink '.../corepack/dist/yarn.js' -> '/usr/bin/yarn'
```

Команда при этом возвращает 0, так что в скрипте ошибку легко пропустить. Решение — задать
каталог явно, см. [подготовку системы](#подготовка-системы).

### `pnpm install` падает на node-pty

**Не воспроизвелось.** Сборка из исходников прошла штатно и заняла считанные секунды: линуксовых
префилдов у `node-pty` 1.1.0 действительно нет (в пакете только `darwin-*` и `win32-*`), модуль
собрался в `build/Release/pty.node` и грузится в том числе под Node 26. Если всё же падает —
не хватает `base-devel` или `python`, см. подготовку системы.

### Electron ругается на отсутствующие библиотеки

**Не воспроизвелось.** `nss`, `gtk3`, `alsa-lib` и `libxss` на CachyOS с KDE уже стоят как
зависимости системы — команда из прошлой редакции этого документа отрабатывает вхолостую.
Оставлена на случай минимальной установки без рабочего стола.

```bash
sudo pacman -S --needed nss gtk3 alsa-lib libxss
```

### Wayland

**Подтвердилось.** В сессии KDE на Wayland у процесса есть и `WAYLAND_DISPLAY`, и `DISPLAY`, и
Electron по умолчанию выбирает второй — окно уезжает в XWayland (видно по стандартной иконке X11
в заголовке). Передать флаг через `pnpm dev` нельзя: `electron-vite dev` принимает только свой
фиксированный набор опций. Поэтому переменной окружения:

```bash
ELECTRON_OZONE_PLATFORM_HINT=auto pnpm dev
```

С ней приложение поднимается штатно. Разницы в отрисовке на 2560×1440 без дробного
масштабирования не заметно — на XWayland окно тоже выглядит нормально, так что подсказка нужна
скорее для дробного масштаба и корректной работы жестов.

**Hub не видит установленный CLI.** Проверь, что бинарник лежит в `PATH` или в одном из мест из
таблицы выше. Отдельный случай: при запуске из терминала `PATH` наследуется и всё в порядке, но
дополнение `PATH` в [`index.ts`](../src/main/index.ts) обёрнуто в проверку на macOS — то есть при
запуске из `.desktop`-ярлыка приложение получит урезанный `PATH` и CLI искать будет негде. Пока
запускаешь через `pnpm dev`, это не проявится.

## Поставить как обычное приложение

Пока нельзя. В [`electron-builder.yml`](../electron-builder.yml) описана только секция `mac`,
Windows и Linux оставлены ненастроенными, и все скрипты в `packaging/` маковые насквозь —
`codesign`, `ditto`, LaunchAgent.

Чтобы получить ставящийся пакет для Arch, нужно добавить в конфиг секцию `linux` с таргетом
`pacman` (electron-builder его умеет) — на выходе будет `.pkg.tar.zst` под `sudo pacman -U`.
Альтернатива без установки — таргет `AppImage`. Для повседневной работы и доработки это не нужно:
`pnpm dev` из папки с кодом закрывает обе задачи.
