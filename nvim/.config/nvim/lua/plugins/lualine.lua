return {
  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      local bg0 = "#1d2021" -- hard background
      local bg1 = "#282828"
      local bg2 = "#3c3836"
      local fg = "#d4be98"
      local green = "#a9b665"
      local blue = "#7daea3"
      local yellow = "#d8a657"
      local red = "#ea6962"
      local purple = "#d3869b"

      opts.options = opts.options or {}
      opts.options.theme = {
        normal = {
          a = { fg = bg0, bg = green, gui = "bold" },
          b = { fg = fg, bg = bg2 },
          c = { fg = fg, bg = bg1 },
        },
        insert = {
          a = { fg = bg0, bg = blue, gui = "bold" },
          b = { fg = fg, bg = bg2 },
          c = { fg = fg, bg = bg1 },
        },
        visual = {
          a = { fg = bg0, bg = purple, gui = "bold" },
          b = { fg = fg, bg = bg2 },
          c = { fg = fg, bg = bg1 },
        },
        replace = {
          a = { fg = bg0, bg = red, gui = "bold" },
          b = { fg = fg, bg = bg2 },
          c = { fg = fg, bg = bg1 },
        },
        command = {
          a = { fg = bg0, bg = yellow, gui = "bold" },
          b = { fg = fg, bg = bg2 },
          c = { fg = fg, bg = bg1 },
        },
        inactive = {
          a = { fg = fg, bg = bg1, gui = "bold" },
          b = { fg = fg, bg = bg1 },
          c = { fg = fg, bg = bg1 },
        },
      }

      -- Boxy look: rectangular blocks, no powerline arrows
      opts.options.section_separators = { left = "", right = "" }
      opts.options.component_separators = { left = "│", right = "│" }

      -- Add padding so each block looks more like a box
      local function pad(component)
        if type(component) == "string" then
          return { component, padding = { left = 1, right = 1 } }
        elseif type(component) == "table" then
          component.padding = component.padding or { left = 1, right = 1 }
          return component
        end
        return component
      end

      if opts.sections then
        for section_name, section in pairs(opts.sections) do
          if type(section_name) == "string" and section_name:match("^lualine_") and type(section) == "table" then
            for i, component in ipairs(section) do
              section[i] = pad(component)
            end
          end
        end
      end

      return opts
    end,
  },
}
