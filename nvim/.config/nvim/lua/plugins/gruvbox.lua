return {
    "sainnhe/gruvbox-material",
    lazy = false, -- Debe cargarse al inicio
    priority = 1000, -- Prioridad máxima para evitar parpadeos
    config = function()
        -- Parámetros de configuración antes de cargar el colorscheme
        vim.g.gruvbox_material_background = "hard" -- Contraste hard
        vim.g.gruvbox_material_enable_italic = 1 -- Habilitar itálicos
        vim.g.gruvbox_material_better_performance = 1 -- Optimización de carga

        -- Opcional: Si quieres que los comentarios también sean itálicos
        -- (algunas fuentes lo requieren explícitamente)
        vim.g.gruvbox_material_disable_italic_comment = 0

        -- Aplicar el colorscheme
        vim.cmd.colorscheme("gruvbox-material")
    end,
    {
        "LazyVim/LazyVim",
        opts = {
            colorscheme = "gruvbox-material",
        },
    },
}
