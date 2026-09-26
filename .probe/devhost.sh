#!/bin/bash
# Проверка расширения в Extension Development Host.
#
#   bash .probe/devhost.sh start            сборка + окно с отладочным профилем
#   bash .probe/devhost.sh load <videoId>   открыть видео в панели
#   bash .probe/devhost.sh state            состояние плеера
#   bash .probe/devhost.sh ready            дождаться готовности потока
#   bash .probe/devhost.sh play|pause       управление воспроизведением
#   bash .probe/devhost.sh seek <сек>       перемотка
#   bash .probe/devhost.sh space            пробел с фокусом в панели
#   bash .probe/devhost.sh click            клик по картинке
#   bash .probe/devhost.sh webview [сек]    что панель приняла от плеера
#   bash .probe/devhost.sh players         состояние каждой страницы плеера
#   bash .probe/devhost.sh streams         что сервер стримит и что закешировал
#   bash .probe/devhost.sh totab           перенести видео в отдельную вкладку
#   bash .probe/devhost.sh panel <выражение> выполнить его в контексте панели
#   bash .probe/devhost.sh chapters        выезжают ли главы у нижнего края
#   bash .probe/devhost.sh setup           что отдаётся при нехватке ffmpeg/yt-dlp
#   bash .probe/devhost.sh claude [on|off|busy|idle]  синхронизация с Claude Code
#   bash .probe/devhost.sh timing <videoId> сколько идёт старт воспроизведения
#   bash .probe/devhost.sh seektiming <сек>  сколько идёт перемотка
#   bash .probe/devhost.sh recover          оборвать поток и проверить восстановление
#   bash .probe/devhost.sh tap              настоящий клик в центр кадра
#   bash .probe/devhost.sh errorfix         вид отказа YouTube с кнопкой копирования
#   bash .probe/devhost.sh avsync [id|auto] [мин] [высота] [plain|fix]  рассинхрон звука
#   bash .probe/devhost.sh smoke <videoId>  весь сценарий: загрузка → play → seek
#   bash .probe/devhost.sh verify           синтаксис webview + сборка + тесты
#   bash .probe/devhost.sh package          проверка и сборка .vsix
#   bash .probe/devhost.sh install-check    поставить .vsix и открыть окно с ним
#   bash .probe/devhost.sh restart          закрыть окно и поднять пересобранное
#   bash .probe/devhost.sh stop             закрыть окно
#
# Окно запускается ровно один раз и само себя не перезапускает: пересборка
# подхватывается только явным restart.
#
# -b первым аргументом (bash .probe/devhost.sh -b restart) — в фоне: окно
# поднимается через open -g и не выходит поверх остальных. Видео load открывает
# всегда через панель по CDP, так что фокус оно не забирает и без -b.
set -u
if [ "${1:-}" = "-b" ]; then export DEVHOST_BG=1; shift; fi
BG="${DEVHOST_BG:-0}"
cd "$(dirname "$0")/.."
ROOT="$PWD"
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
PROFILE="$ROOT/.probe/vscode-user"
EXTENSIONS="$ROOT/.probe/vscode-ext"
export CDP_PORT="${CDP_PORT:-9223}"
ARGS=(--user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS")
CHECK=(node "$ROOT/.probe/devhost-check.js")

cdp_up() { curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; }

# Только процессы этого отладочного профиля, чужие окна VS Code не трогаются.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }
# Главный процесс приложения. У хелперов (рендереры, хосты расширений) свои
# бандлы — «Code Helper.app/Contents/MacOS/…», — и под этот шаблон они не попадают.
main_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep "Code.app/Contents/MacOS/Code " | grep -v grep | awk '{print $1}'; }

case "${1:-}" in
start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	if cdp_up; then echo "окно уже запущено (CDP на $CDP_PORT)"; exit 0; fi
	if [ "$BG" = 1 ]; then
		# Отдельный экземпляр приложения, запущенный без активации. Запущенный
		# изнутри VS Code, скрипт наследует ELECTRON_RUN_AS_NODE, и с ним
		# приложение стартовало бы как голый Node.
		env -u ELECTRON_RUN_AS_NODE open -g -n -a "Visual Studio Code" --stdout "$ROOT/.probe/devhost.log" --stderr "$ROOT/.probe/devhost.log" \
			--args "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" \
			--extensionDevelopmentPath="$ROOT" --new-window "$ROOT"
	else
		"$CODE" "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" \
			--extensionDevelopmentPath="$ROOT" --new-window "$ROOT" > "$ROOT/.probe/devhost.log" 2>&1 &
	fi
	for _ in $(seq 1 30); do sleep 2; cdp_up && { echo "окно готово, CDP на $CDP_PORT"; exit 0; }; done
	echo "окно не поднялось за 60с, см. .probe/devhost.log"; exit 1
	;;

load)
	ID="${2:?нужен videoId}"
	# Панель поднимается не сразу после старта окна.
	for _ in $(seq 1 20); do "${CHECK[@]}" open "$ID" 2>/dev/null | rg -q sent && break; sleep 2; done
	# Панель поднимает страницу плеера и ждёт ответа yt-dlp.
	for _ in $(seq 1 20); do sleep 2; "${CHECK[@]}" targets 2>/dev/null | grep -q "127.0.0.1" && break; done
	"${CHECK[@]}" ready
	;;

state|ready|play|pause|targets|messages|webview|space|click|chapters|setup|claude|timing|seektiming|recover|tap|errorfix|players|panel|totab|streams|open|keys|layout|playin|togglepanel)
	"${CHECK[@]}" "$@"
	;;

seek)
	"${CHECK[@]}" seek "${2:?нужны секунды}"
	;;

avsync)
	npm run compile 2>&1 | rg "error TS" && { echo "сборка упала"; exit 1; }
	shift; node "$ROOT/.probe/avsync.js" "$@"
	;;

smoke)
	ID="${2:-kJQP7kiw5Fk}"
	echo "== загрузка $ID"; bash "$0" load "$ID" || exit 1
	echo "== play";        "${CHECK[@]}" play || exit 1
	echo "== seek 150";    "${CHECK[@]}" seek 150 || exit 1
	echo "== итог";        "${CHECK[@]}" state
	;;

package)
	# Сборка .vsix из текущего состояния: сначала проверка, потом упаковка.
	bash "$0" verify || exit 1
	npx --yes @vscode/vsce package 2>&1 | tail -3
	;;

install-check)
	# Ставит собранный .vsix в отладочный профиль и проверяет его как обычное
	# расширение — без --extensionDevelopmentPath.
	VSIX="${2:-$(ls -t "$ROOT"/*.vsix 2>/dev/null | head -1)}"
	[ -z "$VSIX" ] && { echo "нет .vsix, соберите: devhost.sh package"; exit 1; }
	bash "$0" stop > /dev/null
	"$CODE" "${ARGS[@]}" --install-extension "$VSIX" --force 2>&1 | tail -2
	"$CODE" "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" --new-window "$ROOT" > "$ROOT/.probe/devhost.log" 2>&1 &
	for _ in $(seq 1 30); do sleep 2; cdp_up && break; done
	echo "окно с установленным расширением готово"
	;;

procs)
	# Чем заняты внешние процессы: их число и доля процессора.
	echo "== ffmpeg"
	ps ax -o pid,etime,%cpu,rss,command | grep '[f]fmpeg -loglevel' | awk '{printf "  pid %s, живёт %s, cpu %s%%, память %d МБ\n", $1, $2, $3, $4/1024}' || true
	[ -z "$(ps ax -o command | grep -c '[f]fmpeg -loglevel')" ] && echo "  нет"
	echo "== yt-dlp"
	ps ax -o pid,etime,%cpu,command | grep '[y]t-dlp --no-playlist' | awk '{printf "  pid %s, живёт %s, cpu %s%%\n", $1, $2, $3}' || true
	;;

battery)
	# Сколько процессора уходит на паузе и остаётся ли что-то после закрытия окна.
	echo "== играет"
	"${CHECK[@]}" play > /dev/null 2>&1
	sleep 8; bash "$0" procs

	echo "== на паузе (ждём 20 с)"
	"${CHECK[@]}" pause > /dev/null 2>&1
	sleep 20; bash "$0" procs

	echo "== после закрытия окна"
	bash "$0" stop > /dev/null
	sleep 3; bash "$0" procs
	;;

verify)
	# Скрипт webview не компилируется TypeScript'ом, поэтому проверяется отдельно.
	# Плейсхолдеры вида %%NAME%% подставляются при отдаче страницы, а для
	# разбора синтаксиса на их место годится любое значение.
	sed 's/%%[A-Z_]*%%/null/g' "$ROOT/src/webview/script.js" > "$ROOT/.probe/script.check.js"
	node --check "$ROOT/.probe/script.check.js" || exit 1
	echo "webview: синтаксис ок"
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	echo "сборка: ок"
	npm test 2>&1 | grep -E "passing|failing"
	;;

restart)
	bash "$0" stop || exit 1
	bash "$0" start
	;;

stop)
	[ -z "$(host_pids)" ] && { echo "окно не запущено"; exit 0; }
	# SIGTERM только главному процессу: Electron отвечает на него обычным
	# выходом, как на Cmd+Q, и сам закрывает окна и хелперы. Хелперы, убитые
	# по отдельности, и kill -9 VS Code считает падением — при следующем
	# запуске он восстанавливает окно поверх остальных и теряет globalState.
	MAIN="$(main_pids)"
	[ -z "$MAIN" ] && { echo "главный процесс не найден, остались: $(host_pids)"; exit 1; }
	echo "$MAIN" | xargs kill -TERM 2>/dev/null
	for _ in $(seq 1 30); do sleep 1; [ -z "$(host_pids)" ] && { echo "окно закрыто"; exit 0; }; done
	echo "окно не закрылось за 30 с, процессы: $(host_pids) — принудительно не добиваю"; exit 1
	;;

*)
	grep '^#' "$0" | sed -n '2,20p' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
