return {
    "mfussenegger/nvim-jdtls",
    ft = "java",
    config = function()
        require("config.jdtls").setup()
    end,
}
