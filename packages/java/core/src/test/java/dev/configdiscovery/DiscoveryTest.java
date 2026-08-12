package dev.configdiscovery;

import static dev.configdiscovery.TestTrees.tree;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DiscoveryTest {

    private final List<String> warnings = new ArrayList<>();

    @Test
    void findsAConfigTwoLevelsUp(@TempDir Path temp) {
        Path root = tree(temp, ".git", "", ".config/mytool/config.toml", "a = 1\n", "a/b/", "");
        assertEquals(
                List.of(root.resolve(".config/mytool")),
                Discovery.resolveProjectRoots(root.resolve("a/b"), "mytool", Discovery.WalkOptions.none()));
    }

    @Test
    void rootsComeBackFarthestAncestorFirst(@TempDir Path temp) {
        Path root = tree(
                temp,
                ".git", "",
                ".config/mytool/config.toml", "a = 1\n",
                "pkg/.config/mytool/config.toml", "a = 2\n",
                "pkg/src/", "");
        // Order is the contract: the nearest root is last, and last is what wins.
        assertEquals(
                List.of(root.resolve(".config/mytool"), root.resolve("pkg/.config/mytool")),
                Discovery.resolveProjectRoots(root.resolve("pkg/src"), "mytool", Discovery.WalkOptions.none()));
    }

    @Test
    void aGitDirectoryStopsTheWalk(@TempDir Path temp) {
        Path root = tree(
                temp, ".config/mytool/config.toml", "a = 1\n", "repo/.git/HEAD", "ref: main\n", "repo/pkg/", "");
        assertTrue(Discovery.resolveProjectRoots(
                        root.resolve("repo/pkg"), "mytool", Discovery.WalkOptions.none())
                .isEmpty());
    }

    @Test
    void aGitFileAlsoStopsTheWalk(@TempDir Path temp) {
        // The form git writes for a linked worktree or a submodule. Those are repositories too,
        // and a walk that only tests for a directory climbs straight past them.
        Path root = tree(
                temp,
                ".config/mytool/config.toml", "a = 1\n",
                "repo/.git", "gitdir: /elsewhere/.git/worktrees/w\n",
                "repo/pkg/", "");
        assertTrue(Discovery.resolveProjectRoots(
                        root.resolve("repo/pkg"), "mytool", Discovery.WalkOptions.none())
                .isEmpty());
    }

    @Test
    void stopDirIsInclusive(@TempDir Path temp) {
        Path root = tree(temp, ".git", "", "pkg/.config/mytool/config.toml", "a = 1\n", "pkg/src/", "");
        assertEquals(
                List.of(root.resolve("pkg/.config/mytool")),
                Discovery.resolveProjectRoots(
                        root.resolve("pkg/src"),
                        "mytool",
                        new Discovery.WalkOptions(null, root.resolve("pkg"))));
    }

    @Test
    void homeIsInclusive(@TempDir Path temp) {
        Path root = tree(temp, ".git", "", "home/.config/mytool/config.toml", "a = 1\n", "home/work/", "");
        assertEquals(
                List.of(root.resolve("home/.config/mytool")),
                Discovery.resolveProjectRoots(
                        root.resolve("home/work"), "mytool", new Discovery.WalkOptions(root.resolve("home"), null)));
    }

    @Test
    void theDepthCapFires(@TempDir Path temp) throws IOException {
        Path deep = temp;
        for (int index = 0; index < Discovery.MAX_DEPTH + 6; index++) {
            deep = deep.resolve("d");
        }
        Files.createDirectories(deep);
        Path start = deep;
        ConfigException failure = assertThrows(
                ConfigException.class,
                () -> Discovery.resolveProjectRoots(start, "mytool", Discovery.WalkOptions.none()));
        assertTrue(failure.getMessage().contains("exceeded 64 directories"), failure.getMessage());
    }

    @Test
    void userRootPrefersAnAbsoluteXdg(@TempDir Path temp) {
        Path root = tree(temp, "xdg/mytool/config.toml", "a = 1\n", "home/.config/mytool/config.toml", "a = 2\n");
        assertEquals(
                Optional.of(root.resolve("xdg/mytool")),
                Discovery.resolveUserRoot(
                        "mytool",
                        root.resolve("home"),
                        Map.of("XDG_CONFIG_HOME", root.resolve("xdg").toString()),
                        warnings::add));
    }

    @Test
    void userRootIgnoresARelativeXdgAndWarns(@TempDir Path temp) {
        Path root = tree(temp, "home/.config/mytool/config.toml", "a = 1\n");
        assertEquals(
                Optional.of(root.resolve("home/.config/mytool")),
                Discovery.resolveUserRoot(
                        "mytool", root.resolve("home"), Map.of("XDG_CONFIG_HOME", "../cfg"), warnings::add));
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).contains("absolute"), warnings.get(0));
    }

    @Test
    void userRootIgnoresABlankXdgAndWarns(@TempDir Path temp) {
        Path root = tree(temp, "home/.config/mytool/config.toml", "a = 1\n");
        assertEquals(
                Optional.of(root.resolve("home/.config/mytool")),
                Discovery.resolveUserRoot(
                        "mytool", root.resolve("home"), Map.of("XDG_CONFIG_HOME", "  "), warnings::add));
        assertEquals(1, warnings.size());
    }

    @Test
    void userRootFallsBackWithoutWarning(@TempDir Path temp) {
        Path root = tree(temp, "home/.config/mytool/config.toml", "a = 1\n");
        assertEquals(
                Optional.of(root.resolve("home/.config/mytool")),
                Discovery.resolveUserRoot("mytool", root.resolve("home"), Map.of(), warnings::add));
        assertTrue(warnings.isEmpty());
    }

    @Test
    void userRootIsEmptyWhenTheDirectoryIsMissing(@TempDir Path temp) {
        Path root = tree(temp, "home/", "");
        assertEquals(
                Optional.empty(),
                Discovery.resolveUserRoot("mytool", root.resolve("home"), Map.of(), warnings::add));
    }
}
