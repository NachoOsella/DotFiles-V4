return {
    "vyfor/cord.nvim",
    event = "VeryLazy",
    build = ":Cord update",
    opts = {
        display = {
            theme = "atom",
            flavor = "dark",
        },
    },
}
