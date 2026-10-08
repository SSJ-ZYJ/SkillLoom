local chapter_id = ""
local classes = {"objectives", "definition", "mechanism", "formula", "example",
                 "problem", "analysis", "answer", "pitfall", "takeaway"}
local escapes = {
  ["\\"] = "\\textbackslash{}", ["{"] = "\\{", ["}"] = "\\}",
  ["%"] = "\\%", ["&"] = "\\&", ["#"] = "\\#", ["_"] = "\\_",
  ["$"] = "\\$", ["~"] = "\\textasciitilde{}", ["^"] = "\\textasciicircum{}",
}
local function escape_tex(text)
  return text:gsub(".", function(c) return escapes[c] or c end)
end
local function prefixed(identifier)
  if identifier == "" or identifier:match("^ch%d+%-") then return identifier end
  return chapter_id .. "-" .. identifier
end

return {
  {Meta = function(meta)
    chapter_id = pandoc.utils.stringify(meta["chapter-id"] or "")
    if not chapter_id:match("^ch%d%d%d*$") then
      error("Pass a unique chapter-id (chNN) to this filter")
    end
  end},
  {
    Header = function(header)
      header.identifier = prefixed(header.identifier)
      return header
    end,
    Link = function(link)
      if link.target:sub(1, 1) == "#" then
        link.target = "#" .. prefixed(link.target:sub(2))
      end
      return link
    end,
    HorizontalRule = function() return {} end,
    Div = function(div)
      local selected = nil
      for _, class in ipairs(classes) do
        for _, actual in ipairs(div.classes) do
          if actual == class then
            if selected then error("A div must not have multiple learning-box classes") end
            selected = class
          end
        end
      end
      if not selected then return div end
      local blocks = {pandoc.RawBlock("latex", "\\begin{" .. selected .. "box}{" ..
                              escape_tex(div.attributes.title or "") .. "}")}
      for _, block in ipairs(div.content) do blocks[#blocks + 1] = block end
      blocks[#blocks + 1] = pandoc.RawBlock("latex", "\\end{" .. selected .. "box}")
      return blocks
    end,
  },
}
