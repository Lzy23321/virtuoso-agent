; Controlled Virtuoso bridge functions for virtuoso-agent.
; This file intentionally exposes small, named operations instead of arbitrary
; SKILL evaluation.

procedure(vaJsonEscape(value)
	let((text escaped index char)
		text = if(value then
			if(stringp(value) then sprintf(nil "%s" value) else sprintf(nil "%L" value))
		else
			""
		)
		escaped = ""
		for(index 1 strlen(text)
			char = substring(text index 1)
			escaped = strcat(
				escaped
				if(char == "\\" then
					"\\\\"
				else
					if(char == "\"" then
						"\\\""
					else
						char
					)
				)
			)
		)
		escaped
	)
)

procedure(vaJsonString(value)
	strcat("\"" vaJsonEscape(value) "\"")
)

procedure(vaPrintOk(data)
	printf("{\"ok\":true,\"value\":%s}\n" data)
	t
)

procedure(vaPrintError(errorType message)
	printf(
		"{\"ok\":false,\"error\":{\"type\":%s,\"message\":%s}}\n"
		vaJsonString(errorType)
		vaJsonString(message)
	)
	nil
)

procedure(vaOkEnvelope(data)
	sprintf(nil "{\"ok\":true,\"value\":%s}\n" data)
)

procedure(vaErrorEnvelope(errorType message)
	sprintf(
		nil
		"{\"ok\":false,\"error\":{\"type\":%s,\"message\":%s}}\n"
		vaJsonString(errorType)
		vaJsonString(message)
	)
)

procedure(vaLibraryPath(libId)
	let((path)
		path = libId~>readPath
		if(path then path else libId~>writePath)
	)
)

procedure(vaViewJson(viewId)
	sprintf(nil "{\"name\":%s}" vaJsonString(viewId~>name))
)

procedure(vaCellInventoryJson(cellId)
	let((items sep count)
		items = ""
		sep = ""
		count = 0
		foreach(view cellId~>views
			items = strcat(items sep vaViewJson(view))
			sep = ","
			count = count + 1
		)
		sprintf(
			nil
			"{\"name\":%s,\"counts\":{\"views\":%L},\"views\":[%s]}"
			vaJsonString(cellId~>name)
			count
			items
		)
	)
)

procedure(vaLibraryInventoryJson(libId includeCells)
	let((items sep cellCount viewCount path)
		items = ""
		sep = ""
		cellCount = 0
		viewCount = 0
		foreach(cell libId~>cells
			cellCount = cellCount + 1
			foreach(view cell~>views
				viewCount = viewCount + 1
			)
			when(includeCells
				items = strcat(items sep vaCellInventoryJson(cell))
				sep = ","
			)
		)
		path = vaLibraryPath(libId)
		sprintf(
			nil
			"{\"name\":%s,\"path\":%s,\"counts\":{\"cells\":%L,\"views\":%L},\"cells\":[%s]}"
			vaJsonString(libId~>name)
			vaJsonString(path)
			cellCount
			viewCount
			items
		)
	)
)

procedure(vaLibrariesJson()
	let((items sep libCount cellCount viewCount)
		items = ""
		sep = ""
		libCount = 0
		cellCount = 0
		viewCount = 0
		foreach(lib ddGetLibList()
			items = strcat(items sep vaLibraryInventoryJson(lib nil))
			sep = ","
			libCount = libCount + 1
			foreach(cell lib~>cells
				cellCount = cellCount + 1
				foreach(view cell~>views
					viewCount = viewCount + 1
				)
			)
		)
		sprintf(
			nil
			"{\"counts\":{\"libraries\":%L,\"cells\":%L,\"views\":%L},\"libraries\":[%s]}"
			libCount
			cellCount
			viewCount
			items
		)
	)
)

procedure(vaListLibraries()
	vaPrintOk(vaLibrariesJson())
)

procedure(vaListCellViews(library)
	let((libId)
		libId = ddGetObj(library)
		if(libId then
			vaPrintOk(vaLibraryInventoryJson(libId t))
		else
			vaPrintError("LIBRARY_NOT_FOUND" sprintf(nil "Could not find library %s." library))
		)
	)
)

procedure(vaSessionListLibraries(resultPath)
	vaSessionWriteResult(resultPath vaOkEnvelope(vaLibrariesJson()))
)

procedure(vaSessionListCellViews(library resultPath)
	let((libId data)
		libId = ddGetObj(library)
		data = if(libId then
			vaOkEnvelope(vaLibraryInventoryJson(libId t))
		else
			vaErrorEnvelope("LIBRARY_NOT_FOUND" sprintf(nil "Could not find library %s." library))
		)
		vaSessionWriteResult(resultPath data)
	)
)

procedure(vaCellViewJson(cv)
	sprintf(
		nil
		"{\"library\":%s,\"cell\":%s,\"view\":%s,\"mode\":%s}"
		vaJsonString(cv~>libName)
		vaJsonString(cv~>cellName)
		vaJsonString(cv~>viewName)
		vaJsonString(cv~>mode)
	)
)

procedure(vaCellViewRefJson(library cell view mode)
	sprintf(
		nil
		"{\"library\":%s,\"cell\":%s,\"view\":%s,\"mode\":%s}"
		vaJsonString(library)
		vaJsonString(cell)
		vaJsonString(view)
		vaJsonString(mode)
	)
)

procedure(vaOpenCellViewOrPrintError(library cell view mode)
	let((openMode cv)
		openMode = if(mode then mode else "r")
		cv = dbOpenCellViewByType(library cell view "" openMode)
		if(cv then
			cv
		else
			vaPrintError(
				"CELLVIEW_OPEN_FAILED"
				sprintf(nil "Could not open %s/%s/%s with mode %s." library cell view openMode)
			)
			nil
		)
	)
)

procedure(vaOpenCellView(library cell view mode)
	let((openMode cv)
		openMode = if(mode then mode else "r")
		cv = dbOpenCellViewByType(library cell view "" openMode)
		if(cv then
			vaPrintOk(vaCellViewJson(cv))
		else
			vaPrintError(
				"CELLVIEW_OPEN_FAILED"
				sprintf(nil "Could not open %s/%s/%s with mode %s." library cell view openMode)
			)
		)
	)
)

procedure(vaInstanceJson(inst)
	let((master library cell view)
		master = inst~>master
		library = if(master then master~>libName else "")
		cell = if(master then master~>cellName else "")
		view = if(master then master~>viewName else "")
		sprintf(
			nil
			"{\"name\":%s,\"library\":%s,\"cell\":%s,\"view\":%s}"
			vaJsonString(inst~>name)
			vaJsonString(library)
			vaJsonString(cell)
			vaJsonString(view)
		)
	)
)

procedure(vaListInstances(library cell view mode)
	let((cv items sep)
		cv = vaOpenCellViewOrPrintError(library cell view mode)
		if(cv then
			items = ""
			sep = ""
			foreach(inst cv~>instances
				items = strcat(items sep vaInstanceJson(inst))
				sep = ","
			)
			vaPrintOk(
				sprintf(
					nil
					"{\"cellView\":%s,\"instances\":[%s]}"
					vaCellViewJson(cv)
					items
				)
			)
		)
	)
)

procedure(vaFindInstance(cv instanceName)
	let((found)
		found = nil
		foreach(inst cv~>instances
			if(inst~>name == instanceName then
				found = inst
			)
		)
		found
	)
)

procedure(vaHasSummaryParameterValue(value)
	if(value then
		if(stringp(value) then strlen(value) > 0 else t)
	else
		nil
	)
)

procedure(vaParameterValue(param)
	let((value defValue)
		value = param~>value
		defValue = param~>defValue
		if(vaHasSummaryParameterValue(value) then value else defValue)
	)
)

procedure(vaInstanceParameterJson(param)
	sprintf(
		nil
		"{\"name\":%s,\"value\":%s}"
		vaJsonString(param~>name)
		vaJsonString(vaParameterValue(param))
	)
)

procedure(vaInstanceParametersJson(inst)
	let((cdf items sep)
		cdf = cdfGetInstCDF(inst)
		items = ""
		sep = ""
		if(cdf then
			foreach(param cdf~>parameters
				items = strcat(items sep vaInstanceParameterJson(param))
				sep = ","
			)
		)
		items
	)
)

procedure(vaInstancePropertyJson(prop)
	sprintf(
		nil
		"{\"name\":%s,\"value\":%s}"
		vaJsonString(prop~>name)
		vaJsonString(prop~>value)
	)
)

procedure(vaInstancePropertiesJson(inst)
	let((items sep value)
		items = ""
		sep = ""
		foreach(prop inst~>prop
			value = prop~>value
			if(vaHasSummaryParameterValue(value) then
				items = strcat(items sep vaInstancePropertyJson(prop))
				sep = ","
			)
		)
		items
	)
)

procedure(vaSummaryParametersJson(inst)
	vaInstancePropertiesJson(inst)
)

procedure(vaInstanceSummaryJson(inst)
	let((master library cell view)
		master = inst~>master
		library = if(master then master~>libName else "")
		cell = if(master then master~>cellName else "")
		view = if(master then master~>viewName else "")
		sprintf(
			nil
			"{\"name\":%s,\"library\":%s,\"cell\":%s,\"view\":%s,\"parameters\":[%s]}"
			vaJsonString(inst~>name)
			vaJsonString(library)
			vaJsonString(cell)
			vaJsonString(view)
			vaSummaryParametersJson(inst)
		)
	)
)

procedure(vaCellViewSummary(library cell view mode)
	let((cv items sep count)
		cv = vaOpenCellViewOrPrintError(library cell view mode)
		if(cv then
			items = ""
			sep = ""
			count = 0
			foreach(inst cv~>instances
				items = strcat(items sep vaInstanceSummaryJson(inst))
				sep = ","
				count = count + 1
			)
			vaPrintOk(
				sprintf(
					nil
					"{\"cellView\":%s,\"counts\":{\"instances\":%L},\"instances\":[%s]}"
					vaCellViewJson(cv)
					count
					items
				)
			)
		)
	)
)

procedure(vaGetInstanceParameters(library cell view instanceName mode)
	let((cv inst)
		cv = vaOpenCellViewOrPrintError(library cell view mode)
		if(cv then
			inst = vaFindInstance(cv instanceName)
			if(inst then
				vaPrintOk(
					sprintf(
						nil
						"{\"cellView\":%s,\"instance\":%s,\"parameters\":[%s]}"
						vaCellViewJson(cv)
						vaInstanceJson(inst)
						vaInstanceParametersJson(inst)
					)
				)
			else
				vaPrintError(
					"INSTANCE_NOT_FOUND"
					sprintf(nil "Could not find instance %s in %s/%s/%s." instanceName library cell view)
				)
			)
		)
	)
)

procedure(vaShowCellView(library cell view mode)
	let((openMode window cv)
		openMode = if(mode then mode else "r")
		window = deOpenCellView(library cell view view nil openMode)
		if(window then
			vaPrintOk(
				sprintf(
					nil
					"{\"library\":%s,\"cell\":%s,\"view\":%s,\"mode\":%s,\"visible\":true}"
					vaJsonString(library)
					vaJsonString(cell)
					vaJsonString(view)
					vaJsonString(openMode)
				)
			)
		else
			cv = dbOpenCellViewByType(library cell view "" openMode)
			if(cv then
				vaPrintError(
					"CELLVIEW_DISPLAY_FAILED"
					sprintf(nil "Opened %s/%s/%s in database mode, but could not display it." library cell view)
				)
			else
				vaPrintError(
					"CELLVIEW_OPEN_FAILED"
					sprintf(nil "Could not open %s/%s/%s with mode %s." library cell view openMode)
				)
			)
		)
	)
)

procedure(vaGetCurrentCellView()
	let((cv)
		cv = geGetEditCellView()
		if(cv then
			vaPrintOk(vaCellViewJson(cv))
		else
			vaPrintError("NO_CURRENT_CELLVIEW" "No current edit cellView is active.")
		)
	)
)

procedure(vaSessionGetCurrentCellView(resultPath)
	let((cv data)
		cv = geGetEditCellView()
		data = if(cv then
			vaOkEnvelope(vaCellViewJson(cv))
		else
			vaErrorEnvelope("NO_CURRENT_CELLVIEW" "No current edit cellView is active.")
		)
		vaSessionWriteResult(resultPath data)
	)
)

procedure(vaWriteTextFile(path text)
	let((port)
		port = outfile(path)
		if(port then
			fprintf(port "%s" text)
			close(port)
			t
		else
			nil
		)
	)
)

procedure(vaSessionCommandDir(sessionDir)
	strcat(sessionDir "/commands")
)

procedure(vaSessionProcessedDir(sessionDir)
	strcat(sessionDir "/processed")
)

procedure(vaSessionResultDir(sessionDir)
	strcat(sessionDir "/results")
)

procedure(vaSessionWriteResult(resultPath data)
	vaWriteTextFile(resultPath data)
)

procedure(vaSessionWriteHeartbeat(heartbeatPath)
	vaWriteTextFile(
		heartbeatPath
		sprintf(nil "{\"heartbeatAt\":%s}\n" vaJsonString(getCurrentTime()))
	)
)

procedure(vaSessionShowCellView(library cell view mode resultPath)
	let((openMode window data)
		openMode = if(mode then mode else "r")
		window = deOpenCellView(library cell view view nil openMode)
		if(window then
			data = sprintf(
				nil
				"{\"ok\":true,\"value\":{\"library\":%s,\"cell\":%s,\"view\":%s,\"mode\":%s,\"visible\":true}}\n"
				vaJsonString(library)
				vaJsonString(cell)
				vaJsonString(view)
				vaJsonString(openMode)
			)
		else
			data = sprintf(
				nil
				"{\"ok\":false,\"error\":{\"type\":\"CELLVIEW_DISPLAY_FAILED\",\"message\":%s}}\n"
				vaJsonString(sprintf(nil "Could not display %s/%s/%s." library cell view))
			)
		)
		vaSessionWriteResult(resultPath data)
	)
)

procedure(vaSessionProcessCommandFile(sessionDir commandPath commandFile)
	let((processedPath)
		load(commandPath)
		processedPath = strcat(vaSessionProcessedDir(sessionDir) "/" commandFile)
		renameFile(commandPath processedPath)
	)
)

procedure(vaSessionPoll(sessionDir heartbeatPath)
	let((commandDir commandFiles commandPath)
		vaSessionWriteHeartbeat(heartbeatPath)
		commandDir = vaSessionCommandDir(sessionDir)
		commandFiles = getDirFiles(commandDir)
		when(commandFiles
			foreach(commandFile commandFiles
				when(strlen(commandFile) > 3
					commandPath = strcat(commandDir "/" commandFile)
					when(substring(commandFile strlen(commandFile)-2 3) == ".il"
						vaSessionProcessCommandFile(sessionDir commandPath commandFile)
					)
				)
			)
		)
		hiRegTimer(sprintf(nil "vaSessionPoll(%L %L)" sessionDir heartbeatPath) 10)
	)
)

procedure(vaStartSessionBridge(sessionDir readyPath heartbeatPath)
	printf("{\"ok\":true,\"value\":{\"bridge\":\"virtuoso-agent\",\"sessionDir\":%s,\"status\":\"started\"}}\n" vaJsonString(sessionDir))
	vaWriteTextFile(readyPath "{\"ok\":true,\"state\":\"ready\"}\n")
	vaSessionWriteHeartbeat(heartbeatPath)
	hiRegTimer(sprintf(nil "vaSessionPoll(%L %L)" sessionDir heartbeatPath) 10)
	t
)
