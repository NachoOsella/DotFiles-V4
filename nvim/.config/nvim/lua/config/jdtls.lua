local M = {}

M.setup = function()
    local jdtls = require "jdtls"

    -- Rutas dinámicas
    local home = os.getenv "HOME"
    local mason_path = vim.fn.stdpath "data" .. "/mason/"
    local lombok_path = mason_path .. "packages/jdtls/lombok.jar"
    local jdtls_path = mason_path .. "packages/jdtls"
    local xml_path = vim.fn.stdpath "config" .. "/lua/config/java-style.xml"

    -- Configuración básica
    local config = {
        cmd = {
            "java",
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.protocol=true",
            "-Dlog.level=ALL",
            "-Xms1g",
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
            "-javaagent:" .. lombok_path, -- IMPRESCINDIBLE PARA LOMBOK
            "-jar",
            vim.fn.glob(jdtls_path .. "/plugins/org.eclipse.equinox.launcher_*.jar"),
            "-configuration",
            jdtls_path .. "/config_linux",
            "-data",
            home .. "/.cache/jdtls-workspace/" .. vim.fn.fnamemodify(vim.fn.getcwd(), ":p:h:t"),
        },
        root_dir = jdtls.setup.find_root { ".git", "mvnw", "gradlew" },

        -- Opciones de inicialización para asegurar que el formateador se cargue
        init_options = {
            bundles = {},
            extendedClientCapabilities = jdtls.extendedClientCapabilities,
        },

        settings = {
            java = {
                format = {
                    enabled = true,
                    settings = {
                        -- Usar el prefijo file:// y asegurar ruta absoluta
                        url = "file://" .. xml_path,
                        profile = "IntelliJ_IDEA_Default",
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

        on_attach = function(client, bufnr)
            -- Atajos extra para Java
            vim.keymap.set("n", "<leader>jo", jdtls.organize_imports, { buffer = bufnr, desc = "Organize Imports" })
            vim.keymap.set("n", "<leader>jv", jdtls.extract_variable, { buffer = bufnr, desc = "Extract Variable" })
            vim.keymap.set("n", "<leader>jc", jdtls.extract_constant, { buffer = bufnr, desc = "Extract Constant" })
            vim.keymap.set("v", "<leader>jm", [[<ESC><CMD>lua require('jdtls').extract_method(true)<CR>]], { buffer = bufnr, desc = "Extract Method" })
        end,

        capabilities = vim.lsp.protocol.make_client_capabilities(),
    }

    jdtls.start_or_attach(config)
end

return M
