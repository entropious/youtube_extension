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
#   bash .probe/devhost.sh smoke <videoId>  весь сценарий: загрузка → play → seek
#   bash .probe/devhost.sh verify           синтаксис webview + сборка + тесты
#   bash .probe/devhost.sh package          проверка и сборка .vsix
#   bash .probe/devhost.sh install-check    поставить .vsix и открыть окно с ним
#   bash .probe/devhost.sh restart          закрыть окно и поднять пересобранное
#   bash .probe/devhost.sh stop             закрыть окно
#
# Окно запускается ровно один раз и само себя не перезапускает: пересборка
# подхватывается только явным restart.
set -u
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

case "${1:-}" in
start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	if cdp_up; then echo "окно уже запущено (CDP на $CDP_PORT)"; exit 0; fi
	"$CODE" "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" \
		--extensionDevelopmentPath="$ROOT" --new-window "$ROOT" > "$ROOT/.probe/devhost.log" 2>&1 &
	for _ in $(seq 1 30); do sleep 2; cdp_up && { echo "окно готово, CDP на $CDP_PORT"; exit 0; }; done
	echo "окно не поднялось за 60с, см. .probe/devhost.log"; exit 1
	;;

load)
	ID="${2:?нужен videoId}"
	"$CODE" "${ARGS[@]}" --open-url \
		"vscode://entro.youtube-panel/load?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D$ID" > /dev/null 2>&1
	# Панель поднимает страницу плеера и ждёт ответа yt-dlp.
	for _ in $(seq 1 20); do sleep 2; "${CHECK[@]}" targets 2>/dev/null | grep -q "127.0.0.1" && break; done
	"${CHECK[@]}" ready
	;;

state|ready|play|pause|targets|messages|webview|space|click|chapters|setup|claude|timing|seektiming|recover|tap|errorfix|players|panel|totab|streams)
	"${CHECK[@]}" "$@"
	;;

seek)
	"${CHECK[@]}" seek "${2:?нужны секунды}"
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
	PIDS="$(host_pids)"
	[ -z "$PIDS" ] && { echo "окно не запущено"; exit 0; }
	# Сначала мягко: на kill -9 VS Code не успевает сбросить globalState, и
	# настройки, изменённые перед закрытием, откатываются к прежним.
	echo "$PIDS" | xargs kill 2>/dev/null
	for _ in $(seq 1 10); do sleep 1; [ -z "$(host_pids)" ] && break; done
	REMAINING="$(host_pids)"
	[ -n "$REMAINING" ] && { echo "$REMAINING" | xargs kill -9; sleep 2; }
	[ -z "$(host_pids)" ] && echo "окно закрыто" || { echo "процессы остались: $(host_pids)"; exit 1; }
	;;

*)
	grep '^#' "$0" | sed -n '2,20p' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
