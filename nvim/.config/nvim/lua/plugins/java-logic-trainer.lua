return {
  "NachoOsella/java-logic-trainer.nvim",
  lazy = false,
  keys = {
    -- Moved to <leader>J (capital J) to avoid collision with nvim-jdtls maps on <leader>j (jc/jv)
    { "<leader>Js", "<cmd>JavaLogicStart<cr>", desc = "Java Logic: start" },
    { "<leader>Jc", "<cmd>JavaLogicCheck<cr>", desc = "Java Logic: check" },
    { "<leader>Jv", "<cmd>JavaLogicRunVisible<cr>", desc = "Java Logic: run visible tests" },
    { "<leader>Jn", "<cmd>JavaLogicNext<cr>", desc = "Java Logic: next" },
    { "<leader>Jh", "<cmd>JavaLogicHint<cr>", desc = "Java Logic: hint" },
    { "<leader>Jp", "<cmd>JavaLogicProgress<cr>", desc = "Java Logic: progress" },
    { "<leader>Jl", "<cmd>JavaLogicList<cr>", desc = "Java Logic: list exercises" },
    { "<leader>Jr", "<cmd>JavaLogicReview<cr>", desc = "Java Logic: review" },
    { "<leader>Jb", "<cmd>JavaLogicBeginner<cr>", desc = "Java Logic: beginner mode" },
    { "<leader>Je", "<cmd>JavaLogicErrors<cr>", desc = "Java Logic: open errors" },
  },
}
