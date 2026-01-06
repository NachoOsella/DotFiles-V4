return {
    "brenoprata10/nvim-highlight-colors",
    opts = {
        ---@usage 'background'|'foreground'|'virtual'
        render = "background",
        -- El símbolo que se mostrará en el virtual text
        virtual_symbol = "■",
        -- Habilitar soporte para nombres de colores (ej. "Red", "Blue")
        enable_named_colors = true,
        -- Habilitar soporte para Tailwind CSS
        enable_tailwind = true,
    },
}
