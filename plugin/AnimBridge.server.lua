-- AnimBridge: connects Roblox Studio to the web animator.
-- Install: Studio > Plugins tab > Plugins Folder, drop this file in, restart Studio.
local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local BASE = "http://localhost:3000" -- change to your Railway URL, e.g. https://your-app.up.railway.app

local PARENT = {
	LowerTorso = "HumanoidRootPart", UpperTorso = "LowerTorso", Head = "UpperTorso",
	RightUpperArm = "UpperTorso", RightLowerArm = "RightUpperArm", RightHand = "RightLowerArm",
	LeftUpperArm = "UpperTorso", LeftLowerArm = "LeftUpperArm", LeftHand = "LeftLowerArm",
	RightUpperLeg = "LowerTorso", RightLowerLeg = "RightUpperLeg", RightFoot = "RightLowerLeg",
	LeftUpperLeg = "LowerTorso", LeftLowerLeg = "LeftUpperLeg", LeftFoot = "LeftLowerLeg",
}
local EASE = {
	linear = { Enum.PoseEasingStyle.Linear, Enum.PoseEasingDirection.In },
	["in"] = { Enum.PoseEasingStyle.Cubic, Enum.PoseEasingDirection.In },
	out = { Enum.PoseEasingStyle.Cubic, Enum.PoseEasingDirection.Out },
	inout = { Enum.PoseEasingStyle.Cubic, Enum.PoseEasingDirection.InOut },
}

-- ---------- UI ----------
local toolbar = plugin:CreateToolbar("AnimBridge")
local button = toolbar:CreateButton("AnimBridge", "Link Studio to the web animator", "")
local widget = plugin:CreateDockWidgetPluginGui("AnimBridge", DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 300, 170, 260, 150))
widget.Title = "AnimBridge"
local theme = settings().Studio.Theme
local frame = Instance.new("Frame")
frame.Size = UDim2.fromScale(1, 1)
frame.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainBackground)
frame.Parent = widget
local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.Parent = frame
Instance.new("UIPadding", frame).PaddingTop = UDim.new(0, 10)

local function make(class, props)
	local o = Instance.new(class)
	o.Size = UDim2.new(1, -20, 0, 28)
	o.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainText)
	o.Font = Enum.Font.BuilderSans
	o.TextSize = 16
	for k, v in props do o[k] = v end
	o.Parent = frame
	return o
end
local status = make("TextLabel", { Text = "Not linked", BackgroundTransparency = 1, TextWrapped = true, Size = UDim2.new(1, -20, 0, 44) })
local box = make("TextBox", { PlaceholderText = "Code from the web app", Text = "", ClearTextOnFocus = false, BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.InputFieldBackground) })
local connect = make("TextButton", { Text = "Link", BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Button) })
button.Click:Connect(function() widget.Enabled = not widget.Enabled end)

-- ---------- HTTP ----------
local function call(method, path, body)
	local ok, res = pcall(HttpService.RequestAsync, HttpService, {
		Url = BASE .. path, Method = method,
		Headers = { ["Content-Type"] = "application/json" },
		Body = body and HttpService:JSONEncode(body) or nil,
	})
	if not ok then return nil, tostring(res) end
	local decoded = pcall(HttpService.JSONDecode, HttpService, res.Body) and HttpService:JSONDecode(res.Body) or {}
	if not res.Success then return nil, decoded.error or ("HTTP " .. res.StatusCode) end
	return decoded
end

-- ---------- build the KeyframeSequence ----------
local function findRig()
	for _, inst in Selection:Get() do
		local m = inst:IsA("Model") and inst or inst:FindFirstAncestorOfClass("Model")
		if m and m:FindFirstChildOfClass("Humanoid") then return m end
	end
end

local function build(anim, rig)
	local ks = Instance.new("KeyframeSequence")
	ks.Name = anim.name
	ks.Loop = anim.loop
	ks.Priority = Enum.AnimationPriority.Action

	local byTime, times = {}, {}
	for joint, track in anim.tracks do
		for _, k in track do
			local id = string.format("%.3f", k.t)
			if not byTime[id] then byTime[id] = { t = k.t, joints = {} }; table.insert(times, id) end
			byTime[id].joints[joint] = k
		end
	end
	table.sort(times, function(a, b) return byTime[a].t < byTime[b].t end)

	for _, id in times do
		local entry = byTime[id]
		local kf = Instance.new("Keyframe")
		kf.Time = entry.t
		local poses = {}
		local function ensure(name)
			if poses[name] then return poses[name] end
			local p = Instance.new("Pose")
			p.Name = name
			p.Weight = 0
			local parentName = PARENT[name]
			p.Parent = parentName and ensure(parentName) or kf
			poses[name] = p
			return p
		end
		for joint, k in entry.joints do
			local p = ensure(joint)
			local pos = k.p or { 0, 0, 0 }
			p.CFrame = CFrame.new(pos[1], pos[2], pos[3]) * CFrame.Angles(math.rad(k.r[1]), math.rad(k.r[2]), math.rad(k.r[3]))
			p.Weight = 1
			local e = EASE[k.e] or EASE.inout
			p.EasingStyle, p.EasingDirection = e[1], e[2]
		end
		kf.Parent = ks
	end

	local folder = rig:FindFirstChild("AnimSaves")
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = "AnimSaves"
		folder.Parent = rig
	end
	ks.Parent = folder
	return ks
end

-- ---------- link + poll ----------
local key = plugin:GetSetting("AnimBridgeKey")
local pending

local function apply(anim)
	local rig = findRig()
	if not rig then
		pending = anim
		status.Text = "Select your R15 rig in the Explorer to receive “" .. anim.name .. "”"
		return
	end
	pending = nil
	local rec = ChangeHistoryService:TryBeginRecording("AnimBridge: " .. anim.name)
	local ok, result = pcall(build, anim, rig)
	if rec then ChangeHistoryService:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel) end
	if ok then
		Selection:Set({ result })
		status.Text = "Added “" .. anim.name .. "” to " .. rig.Name .. " > AnimSaves"
	else
		status.Text = "Build failed: " .. tostring(result)
	end
end

connect.Activated:Connect(function()
	local res, err = call("POST", "/api/plugin/claim", { code = box.Text })
	if res then
		key = res.key
		plugin:SetSetting("AnimBridgeKey", key)
		status.Text = "Linked. Press Apply to Studio in the web app."
	else
		status.Text = "Link failed: " .. tostring(err)
	end
end)

if key then status.Text = "Linked (saved from last session)" end

task.spawn(function()
	while true do
		if pending then
			apply(pending)
		elseif key then
			local res, err = call("GET", "/api/plugin/poll?key=" .. key)
			if res and res.anim then
				apply(res.anim)
			elseif err == "Not linked" then
				key = nil
				plugin:SetSetting("AnimBridgeKey", nil)
				status.Text = "Link expired. Enter a new code."
			end
		end
		task.wait(2)
	end
end)
