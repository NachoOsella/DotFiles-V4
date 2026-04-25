local M = {}

local function get_jdtls_config_dir(jdtls_path)
    local config_dir = "config_linux"

    if vim.fn.has("mac") == 1 then
        config_dir = "config_mac"
    elseif vim.fn.has("win32") == 1 then
        config_dir = "config_win"
    end

    return jdtls_path .. "/" .. config_dir
end

local function get_workspace_dir(root_dir)
    local project_name = vim.fn.fnamemodify(root_dir, ":p:h:t")
    local project_hash = vim.fn.sha256(vim.fn.fnamemodify(root_dir, ":p")):sub(1, 8)

    return vim.fn.stdpath("cache") .. "/jdtls-workspace/" .. project_name .. "-" .. project_hash
end

local function get_capabilities()
    local ok, blink = pcall(require, "blink.cmp")
    if ok and blink.get_lsp_capabilities then
        return blink.get_lsp_capabilities()
    end

    return vim.lsp.protocol.make_client_capabilities()
end

M.setup = function()
    local jdtls = require("jdtls")

    local mason_path = vim.fn.stdpath("data") .. "/mason"
    local jdtls_path = mason_path .. "/packages/jdtls"
    local lombok_path = jdtls_path .. "/lombok.jar"
    local xml_path = vim.fn.stdpath("config") .. "/lua/config/java-style.xml"
    local root_dir = jdtls.setup.find_root({ ".git", "mvnw", "gradlew", "pom.xml", "build.gradle", "build.gradle.kts" })

    if not root_dir then
        vim.notify("No se encontró root_dir para jdtls", vim.log.levels.WARN)
        return
    end

    local launcher = vim.fn.glob(jdtls_path .. "/plugins/org.eclipse.equinox.launcher_*.jar")
    if launcher == "" then
        vim.notify("No se encontró el launcher de jdtls en Mason", vim.log.levels.ERROR)
        return
    end

    local config = {
        cmd = {
            "java",
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.protocol=false",
            "-Dlog.level=WARN",
            "-Xms1g",
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
            "-javaagent:" .. lombok_path,
            "-jar",
            launcher,
            "-configuration",
            get_jdtls_config_dir(jdtls_path),
            "-data",
            get_workspace_dir(root_dir),
        },
        root_dir = root_dir,

        init_options = {
            bundles = {},
            extendedClientCapabilities = jdtls.extendedClientCapabilities,
        },

        settings = {
            java = {
                format = {
                    enabled = true,
                    settings = {
                        url = "file://" .. xml_path,
                        profile = "IntelliJ",
                    },
                },
                signatureHelp = { enabled = true },
                contentProvider = { preferred = "fernflower" },
                completion = {
                    favoriteStaticMembers = {
                        "org.hamcrest.MatcherAssert.assertThat",
                        "org.hamcrest.Matchers.*",
                        "org.hamcrest.CoreMatchers.*",
                        "org.junit.jupiter.api.Assertions.*",
                        "java.util.Objects.requireNonNull",
                        "java.util.Objects.requireNonNullElse",
                        "org.mockito.Mockito.*",
                    },
                },
            },
        },

        on_attach = function(_, bufnr)
            vim.keymap.set("n", "<leader>jo", jdtls.organize_imports, { buffer = bufnr, desc = "Organize Imports" })
            vim.keymap.set("n", "<leader>jv", jdtls.extract_variable, { buffer = bufnr, desc = "Extract Variable" })
            vim.keymap.set("n", "<leader>jc", jdtls.extract_constant, { buffer = bufnr, desc = "Extract Constant" })
            vim.keymap.set(
                "v",
                "<leader>jm",
                [[<ESC><CMD>lua require('jdtls').extract_method(true)<CR>]],
                { buffer = bufnr, desc = "Extract Method" }
            )
        end,

        capabilities = get_capabilities(),
    }

    jdtls.start_or_attach(config)
end

return M
