return {
    {
        "sainnhe/gruvbox-material",
        lazy = false,
        priority = 1000,
        init = function()
            -- La configuración debe establecerse ANTES de cargar el esquema de colores.
            -- Usamos 'init' porque se ejecuta antes de que se cargue el plugin
            -- y antes de que LazyVim intente aplicar el colorscheme.
            vim.g.gruvbox_material_background = "hard"
            vim.g.gruvbox_material_enable_italic = 1
            vim.g.gruvbox_material_better_performance = 1
        end,
        config = function()
            -- Aseguramos el fondo oscuro y cargamos el esquema
            vim.o.background = "dark"
            vim.cmd.colorscheme("gruvbox-material")
        end,
    },
    {
        "LazyVim/LazyVim",
        opts = {
            colorscheme = "gruvbox-material",
        },
    },
}
