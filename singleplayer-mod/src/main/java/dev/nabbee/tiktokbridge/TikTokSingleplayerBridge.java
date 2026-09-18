package dev.nabbee.tiktokbridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A deliberately tiny, loopback-only command receiver for an integrated server.
 * It is not RCON, does not open the world to LAN, and cannot accept remote traffic.
 */
public final class TikTokSingleplayerBridge implements ModInitializer {
    private static final Logger LOGGER = LoggerFactory.getLogger("tiktok-singleplayer-bridge");
    private static final int PORT = 25576;
    private static final int MAX_COMMAND_BYTES = 32_768;
    private static final Map<String, CompletableFuture<String>> RESULTS = new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, CompletableFuture<String>> eldest) {
            return size() > 4_096 && eldest.getValue().isDone();
        }
    };
    private static volatile MinecraftServer activeServer;

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            activeServer = server;
            LOGGER.info("Single-player world ready for TikTok gift commands");
        });
        ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
            if (activeServer == server) activeServer = null;
        });

        try {
            var address = new InetSocketAddress("127.0.0.1", PORT);
            var http = HttpServer.create(address, 0);
            http.createContext("/health", this::health);
            http.createContext("/command", this::command);
            http.setExecutor(Executors.newSingleThreadExecutor(runnable -> {
                var thread = new Thread(runnable, "tiktok-singleplayer-bridge-http");
                thread.setDaemon(true);
                return thread;
            }));
            http.start();
            LOGGER.info("Listening for the local TikTok bridge on 127.0.0.1:{}", PORT);
        } catch (IOException error) {
            LOGGER.error("Could not start the single-player TikTok bridge", error);
        }
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!authorized(exchange) || !"GET".equals(exchange.getRequestMethod())) {
            reply(exchange, 403, "forbidden");
            return;
        }
        if (activeServer == null) reply(exchange, 503, "Minecraft is open, but no single-player world is loaded");
        else reply(exchange, 200, "ready");
    }

    private void command(HttpExchange exchange) throws IOException {
        if (!authorized(exchange) || !"POST".equals(exchange.getRequestMethod())) {
            reply(exchange, 403, "forbidden");
            return;
        }
        var server = activeServer;
        if (server == null) {
            reply(exchange, 503, "Minecraft is open, but no single-player world is loaded");
            return;
        }

        var bytes = exchange.getRequestBody().readNBytes(MAX_COMMAND_BYTES + 1);
        if (bytes.length == 0 || bytes.length > MAX_COMMAND_BYTES) {
            reply(exchange, 400, "command is empty or too large");
            return;
        }
        var raw = new String(bytes, StandardCharsets.UTF_8).trim();
        var command = raw.startsWith("/") ? raw.substring(1) : raw;
        if (command.isBlank() || command.indexOf('\n') >= 0 || command.indexOf('\r') >= 0) {
            reply(exchange, 400, "command must be one non-empty line");
            return;
        }

        var commandId = exchange.getRequestHeaders().getFirst("X-TikTok-Command-Id");
        if (commandId == null || !commandId.matches("[A-Za-z0-9._:-]{1,128}")) {
            reply(exchange, 400, "missing or invalid command id");
            return;
        }

        CompletableFuture<String> result;
        boolean isNew;
        synchronized (RESULTS) {
            result = RESULTS.get(commandId);
            isNew = result == null;
            if (isNew) {
                result = new CompletableFuture<>();
                RESULTS.put(commandId, result);
            }
        }

        if (isNew) {
            var pending = result;
            server.execute(() -> {
                try {
                    var source = server.createCommandSourceStack();
                    var parsed = server.getCommands().getDispatcher().parse(command, source);
                    if (parsed.getReader().canRead() || !parsed.getExceptions().isEmpty()) {
                        pending.complete("Incorrect command at position " + parsed.getReader().getCursor());
                        return;
                    }
                    server.getCommands().performCommand(parsed, command);
                    pending.complete("OK");
                } catch (Exception error) {
                    pending.complete("Invalid command: " + error.getMessage());
                }
            });
        }

        try {
            // Command errors are a successful HTTP exchange so the Node bridge can log
            // the rejection without treating it as a lost connection and retrying it.
            reply(exchange, 200, result.get(5, TimeUnit.SECONDS));
        } catch (Exception error) {
            reply(exchange, 503, "Minecraft did not execute the command in time");
        }
    }

    private static boolean authorized(HttpExchange exchange) {
        return exchange.getRemoteAddress().getAddress().isLoopbackAddress()
            && "1".equals(exchange.getRequestHeaders().getFirst("X-TikTok-Bridge"));
    }

    private static void reply(HttpExchange exchange, int status, String text) throws IOException {
        var bytes = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var body = exchange.getResponseBody()) {
            body.write(bytes);
        }
    }
}
